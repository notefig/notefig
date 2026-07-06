import { z } from "zod";

/**
 * Metrists Relay Protocol — the envelope a relay server understands.
 * Everything above this envelope is opaque ciphertext; a compliant relay
 * only validates these frames and forwards `frame` payloads between the
 * exactly-two peers of a room. Full spec: packages/relay/PROTOCOL.md.
 */
export const RELAY_PROTOCOL_VERSION = 1;

const base = {
  v: z.literal(RELAY_PROTOCOL_VERSION),
  /** Room id derived from the pairing secret; the relay never sees the secret */
  room: z.string().min(16).max(128),
};

export const RelayFrameSchema = z.discriminatedUnion("t", [
  /** Peer → relay: join a room */
  z.object({ ...base, t: z.literal("hello") }),
  /** Relay → peer: join confirmed */
  z.object({ ...base, t: z.literal("joined") }),
  /** Relay → peer: the other side joined / left */
  z.object({ ...base, t: z.literal("peer-joined") }),
  z.object({ ...base, t: z.literal("peer-left") }),
  /** Either direction: one E2E-encrypted message (base64 ciphertext) */
  z.object({
    ...base,
    t: z.literal("frame"),
    seq: z.number().int().nonnegative(),
    payload: z.string().max(1_048_576),
  }),
  /** Relay → peer: protocol error, connection will close */
  z.object({ ...base, t: z.literal("error"), message: z.string() }),
]);

export type RelayFrame = z.infer<typeof RelayFrameSchema>;

/**
 * Channels multiplexed *inside* the encrypted payload (the relay never sees
 * these): "acp" carries one task's JSON-RPC byte stream, "watch" carries
 * file-change events from the worker's watcher, "ctl" carries worker
 * control. The worker treats "acp" bodies as opaque lines — it never parses
 * the protocol; one adapter process per taskId.
 */
export const TunnelChannelSchema = z.enum(["acp", "watch", "ctl"]);
export type TunnelChannel = z.infer<typeof TunnelChannelSchema>;

export const TaskIdSchema = z.string().min(1).max(64);

/** Worker control messages (ctl channel bodies). */
export const CtlMessageSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("start-task"),
    taskId: TaskIdSchema,
    harnessId: z.string().min(1),
    cwd: z.string().min(1),
  }),
  z.object({ op: z.literal("stop-task"), taskId: TaskIdSchema }),
  z.object({ op: z.literal("list-tasks") }),
  /** worker → app */
  z.object({
    op: z.literal("task-exit"),
    taskId: TaskIdSchema,
    code: z.number().int().nullable(),
  }),
]);
export type CtlMessage = z.infer<typeof CtlMessageSchema>;

export const TunnelMessageSchema = z.object({
  ch: TunnelChannelSchema,
  /** Required for "acp" (routes to that task's process); absent for "watch". */
  taskId: TaskIdSchema.optional(),
  body: z.unknown(),
});
export type TunnelMessage = z.infer<typeof TunnelMessageSchema>;
