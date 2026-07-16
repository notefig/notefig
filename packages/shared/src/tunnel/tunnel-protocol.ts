/**
 * Metrists Tunnel Protocol — encrypted frames between the web app (browser)
 * and the `metrists agent` CLI worker. By default the browser connects
 * straight to the worker's local `ws://127.0.0.1:<port>` (same machine);
 * `--tunnel-url` points it at any wss:// endpoint instead for remote access.
 * Either way the substrate is a dumb pipe: everything after the plaintext
 * envelope is XSalsa20-Poly1305 ciphertext under a pairing-derived key, so
 * even an untrusted relay (or a stray local process) learns nothing and
 * can't drive the worker.
 *
 * Normative spec: ./PROTOCOL.md. The worker never parses an "acp" or "mcp"
 * data string — protocol logic lives in the browser on both platforms.
 */
import { z } from "zod";
import nacl from "tweetnacl";

import {
  base64ToBytes,
  bytesToBase64,
  utf8Decode,
  utf8Encode,
} from "./encoding";

export const TUNNEL_PROTOCOL_VERSION = 1;

/** 4 MiB ciphertext cap — backpressure/flow control is a v2 concern. */
export const MAX_FRAME_PAYLOAD_BASE64 = 4_194_304;

export const TunnelErrorCodeSchema = z.enum([
  "version-mismatch",
  "pairing-failed",
  "busy",
  "protocol-error",
]);
export type TunnelErrorCode = z.infer<typeof TunnelErrorCodeSchema>;

/**
 * The plaintext outer envelope (JSON text frames on the WebSocket).
 * `hello` flows worker → browser once per connection; `error` is plaintext
 * by necessity (pre-key or key-failure); everything else is a `frame`.
 */
export const TunnelEnvelopeSchema = z.discriminatedUnion("t", [
  z.object({
    v: z.literal(TUNNEL_PROTOCOL_VERSION),
    t: z.literal("hello"),
    /** base64, 16 random bytes; echoed back inside the first encrypted frame */
    challenge: z.string().min(1).max(64),
  }),
  z.object({
    v: z.literal(TUNNEL_PROTOCOL_VERSION),
    t: z.literal("frame"),
    seq: z.number().int().nonnegative(),
    /** base64 XSalsa20-Poly1305 ciphertext of one InnerFrame */
    payload: z.string().max(MAX_FRAME_PAYLOAD_BASE64),
  }),
  z.object({
    v: z.literal(TUNNEL_PROTOCOL_VERSION),
    t: z.literal("error"),
    code: TunnelErrorCodeSchema,
    message: z.string(),
  }),
]);
export type TunnelEnvelope = z.infer<typeof TunnelEnvelopeSchema>;
export type TunnelFrameEnvelope = Extract<TunnelEnvelope, { t: "frame" }>;

export const TunnelChannelSchema = z.enum(["acp", "mcp", "ctl"]);
export type TunnelChannel = z.infer<typeof TunnelChannelSchema>;

export const TaskIdSchema = z.string().min(1).max(64);

/**
 * The decrypted payload of one `frame`. The worker is a pure byte pump — it
 * never parses an "acp" or "mcp" line; files are the browser fs adapter's
 * job and never cross the tunnel. Channel semantics:
 * - "acp":   data = one JSON-RPC line (opaque string), taskId required
 * - "mcp":   data = one MCP line (opaque string), taskId + connId required;
 *            connId is minted worker-side per accepted relay connection
 * - "ctl":   data = CtlMessage
 */
export const InnerFrameSchema = z.object({
  ch: TunnelChannelSchema,
  taskId: TaskIdSchema.optional(),
  connId: z.number().int().nonnegative().optional(),
  data: z.unknown(),
});
export type InnerFrame = z.infer<typeof InnerFrameSchema>;

// ========== ctl channel ==========

export const HarnessAdvertSchema = z.object({
  id: z.string().min(1),
  available: z.boolean(),
});
export type HarnessAdvert = z.infer<typeof HarnessAdvertSchema>;

export const WorkerInfoSchema = z.object({
  /** os.hostname() — the "paired with <name>" surface */
  name: z.string(),
  /** resolved --dir, worker-absolute; task rows key off this path */
  workspacePath: z.string().min(1),
  harnesses: z.array(HarnessAdvertSchema),
  protocol: z.number().int(),
});
export type WorkerInfo = z.infer<typeof WorkerInfoSchema>;

export const McpServerSpecSchema = z.object({
  name: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  env: z.array(z.object({ name: z.string(), value: z.string() })),
});
export type McpServerSpec = z.infer<typeof McpServerSpecSchema>;

/** Worker control messages (ctl channel bodies). */
export const CtlMessageSchema = z.discriminatedUnion("op", [
  /** browser → worker: FIRST encrypted frame (seq 0), echoes hello.challenge */
  z.object({ op: z.literal("pair"), challenge: z.string() }),
  /** worker → browser: pairing accepted, here is who you are talking to */
  z.object({ op: z.literal("pair-ack"), worker: WorkerInfoSchema }),

  z.object({
    op: z.literal("start-task"),
    taskId: TaskIdSchema,
    harnessId: z.string().min(1),
    cwd: z.string().min(1),
    /** per-task env on top of the harness's static env (e.g. OPENCODE_CONFIG) */
    extraEnv: z.record(z.string()).default({}),
  }),
  /** worker → browser */
  z.object({ op: z.literal("task-started"), taskId: TaskIdSchema }),
  /** worker → browser */
  z.object({
    op: z.literal("task-spawn-error"),
    taskId: TaskIdSchema,
    message: z.string(),
  }),
  z.object({ op: z.literal("stop-task"), taskId: TaskIdSchema }),
  /** worker → browser */
  z.object({
    op: z.literal("task-exit"),
    taskId: TaskIdSchema,
    code: z.number().int().nullable(),
  }),
  /** worker → browser: adapter stderr side channel */
  z.object({
    op: z.literal("task-diagnostic"),
    taskId: TaskIdSchema,
    line: z.string(),
  }),

  /** browser → worker: open this task's loopback MCP listener */
  z.object({ op: z.literal("mcp-open"), taskId: TaskIdSchema }),
  /** worker → browser: the stdio spec the harness should spawn (worker paths) */
  z.object({
    op: z.literal("mcp-opened"),
    taskId: TaskIdSchema,
    mcpServer: McpServerSpecSchema,
  }),
  z.object({ op: z.literal("mcp-close"), taskId: TaskIdSchema }),
]);
export type CtlMessage = z.infer<typeof CtlMessageSchema>;

// ========== frame crypto ==========

export type TunnelRole = "browser" | "worker";

const DIRECTION_TAG: Record<TunnelRole, number> = {
  browser: 0x01,
  worker: 0x02,
};

const NONCE_BYTES = 24;

/** 24-byte nonce: byte 0 = direction tag, bytes 1–23 = big-endian counter. */
function frameNonce(role: TunnelRole, seq: number): Uint8Array {
  if (!Number.isSafeInteger(seq) || seq < 0) {
    throw new Error(`invalid frame counter: ${seq}`);
  }
  const nonce = new Uint8Array(NONCE_BYTES);
  nonce[0] = DIRECTION_TAG[role];
  let rest = seq;
  for (let i = NONCE_BYTES - 1; rest > 0; i--) {
    nonce[i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  return nonce;
}

/**
 * Sequenced, direction-tagged frame encryption. Each peer holds one
 * FrameCipher constructed with its own role; `seal` numbers outbound frames
 * from 0, `open` requires inbound frames to arrive in exact sequence and
 * returns null on any gap, repeat, tamper, or wrong-direction nonce — the
 * caller must hard-close the connection when that happens.
 */
export class FrameCipher {
  private sendSeq = 0;
  private lastRecvSeq = -1;

  constructor(
    private readonly frameKey: Uint8Array,
    private readonly role: TunnelRole,
  ) {
    if (frameKey.length !== nacl.secretbox.keyLength) {
      throw new Error(`frame key must be ${nacl.secretbox.keyLength} bytes`);
    }
  }

  seal(inner: InnerFrame): TunnelFrameEnvelope {
    const seq = this.sendSeq++;
    const box = nacl.secretbox(
      utf8Encode(JSON.stringify(inner)),
      frameNonce(this.role, seq),
      this.frameKey,
    );
    return {
      v: TUNNEL_PROTOCOL_VERSION,
      t: "frame",
      seq,
      payload: bytesToBase64(box),
    };
  }

  open(envelope: TunnelFrameEnvelope): InnerFrame | null {
    if (envelope.seq !== this.lastRecvSeq + 1) return null;
    const senderRole: TunnelRole = this.role === "browser" ? "worker" : "browser";
    let opened: Uint8Array | null;
    try {
      opened = nacl.secretbox.open(
        base64ToBytes(envelope.payload),
        frameNonce(senderRole, envelope.seq),
        this.frameKey,
      );
    } catch {
      return null;
    }
    if (!opened) return null;
    let inner: InnerFrame;
    try {
      inner = InnerFrameSchema.parse(JSON.parse(utf8Decode(opened)));
    } catch {
      return null;
    }
    this.lastRecvSeq = envelope.seq;
    return inner;
  }
}
