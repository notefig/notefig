import {
  CtlMessageSchema,
  FrameCipher,
  InnerFrameSchema,
  TUNNEL_PROTOCOL_VERSION,
  TunnelEnvelopeSchema,
  type CtlMessage,
  type InnerFrame,
} from "./tunnel-protocol";
import { deriveFrameKey, deriveSessionKey } from "./pairing";
import {
  VECTOR_BROWSER_SEQ0_PAYLOAD_B64,
  VECTOR_CHALLENGE_HEX,
  VECTOR_FRAME_KEY_HEX,
  VECTOR_INNER_FRAME,
  VECTOR_SECRET_HEX,
  VECTOR_SESSION_KEY_HEX,
  VECTOR_WORKER_SEQ0_PAYLOAD_B64,
} from "./test-vectors";

const hexToBytes = (hex: string) =>
  new Uint8Array(hex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));

const sessionKey = () => hexToBytes(VECTOR_SESSION_KEY_HEX);

describe("fixed vectors (cross-runtime symmetry)", () => {
  it("derives the pinned frame key from the pinned secret", async () => {
    const key = await deriveFrameKey(hexToBytes(VECTOR_SECRET_HEX));
    expect(Buffer.from(key).toString("hex")).toBe(VECTOR_FRAME_KEY_HEX);
  });

  it("derives the pinned session key from frame key + challenge", async () => {
    const key = await deriveSessionKey(
      hexToBytes(VECTOR_FRAME_KEY_HEX),
      hexToBytes(VECTOR_CHALLENGE_HEX),
    );
    expect(Buffer.from(key).toString("hex")).toBe(VECTOR_SESSION_KEY_HEX);
  });

  it("seals the pinned inner frame to the pinned ciphertexts at seq 0", () => {
    const browser = new FrameCipher(sessionKey(), "browser");
    const worker = new FrameCipher(sessionKey(), "worker");
    expect(browser.seal(VECTOR_INNER_FRAME).payload).toBe(
      VECTOR_BROWSER_SEQ0_PAYLOAD_B64,
    );
    expect(worker.seal(VECTOR_INNER_FRAME).payload).toBe(
      VECTOR_WORKER_SEQ0_PAYLOAD_B64,
    );
  });
});

describe("FrameCipher", () => {
  const inner: InnerFrame = { ch: "ctl", data: { op: "pair", challenge: "x" } };

  it("round-trips frames in both directions", () => {
    const browser = new FrameCipher(sessionKey(), "browser");
    const worker = new FrameCipher(sessionKey(), "worker");
    for (let i = 0; i < 3; i++) {
      const toWorker: InnerFrame = { ch: "mcp", taskId: "t", connId: i, data: `b${i}` };
      expect(worker.open(browser.seal(toWorker))).toEqual(toWorker);
      const toBrowser: InnerFrame = { ch: "mcp", taskId: "t", connId: i, data: `w${i}` };
      expect(browser.open(worker.seal(toBrowser))).toEqual(toBrowser);
    }
  });

  it("rejects tampered ciphertext", () => {
    const browser = new FrameCipher(sessionKey(), "browser");
    const worker = new FrameCipher(sessionKey(), "worker");
    const envelope = browser.seal(inner);
    const tampered = {
      ...envelope,
      payload: `${envelope.payload.slice(0, -5)}AAAA=`,
    };
    expect(worker.open(tampered)).toBeNull();
  });

  it("rejects a replayed seq", () => {
    const browser = new FrameCipher(sessionKey(), "browser");
    const worker = new FrameCipher(sessionKey(), "worker");
    const envelope = browser.seal(inner);
    expect(worker.open(envelope)).not.toBeNull();
    expect(worker.open(envelope)).toBeNull();
  });

  it("rejects a skipped seq", () => {
    const browser = new FrameCipher(sessionKey(), "browser");
    const worker = new FrameCipher(sessionKey(), "worker");
    browser.seal(inner); // seq 0 never delivered
    const second = browser.seal(inner);
    expect(worker.open(second)).toBeNull();
  });

  it("rejects a wrong-direction nonce (reflected frame)", () => {
    const browser = new FrameCipher(sessionKey(), "browser");
    const otherBrowser = new FrameCipher(sessionKey(), "browser");
    const envelope = browser.seal(inner);
    // A browser-sealed frame reflected back at a browser-side cipher must
    // not decrypt, even though key and seq both match.
    expect(otherBrowser.open(envelope)).toBeNull();
  });

  it("rejects a frame sealed under a different key", () => {
    const browser = new FrameCipher(sessionKey(), "browser");
    const wrongKey = new Uint8Array(32).fill(7);
    const worker = new FrameCipher(wrongKey, "worker");
    expect(worker.open(browser.seal(inner))).toBeNull();
  });
});

describe("schemas", () => {
  it("round-trips every ctl op through JSON", () => {
    const ops: CtlMessage[] = [
      { op: "pair", challenge: "abc" },
      {
        op: "pair-ack",
        worker: {
          name: "mbp",
          workspacePath: "/Users/x/book",
          harnesses: [{ id: "claude-code", available: true }],
          protocol: TUNNEL_PROTOCOL_VERSION,
        },
      },
      {
        op: "start-task",
        taskId: "t1",
        harnessId: "claude-code",
        cwd: "/Users/x/book",
        extraEnv: { OPENCODE_CONFIG: "/tmp/x.json" },
      },
      { op: "task-started", taskId: "t1" },
      { op: "task-spawn-error", taskId: "t1", message: "ENOENT" },
      { op: "stop-task", taskId: "t1" },
      { op: "task-exit", taskId: "t1", code: null },
      { op: "task-diagnostic", taskId: "t1", line: "warn" },
      { op: "mcp-open", taskId: "t1" },
      {
        op: "mcp-opened",
        taskId: "t1",
        mcpServer: {
          name: "metrists",
          command: "/usr/local/bin/node",
          args: ["cli.js", "mcp-relay", "--port", "1234"],
          env: [{ name: "NOTEFIG_MCP_TOKEN", value: "tok" }],
        },
      },
      { op: "mcp-close", taskId: "t1" },
    ];
    for (const op of ops) {
      expect(CtlMessageSchema.parse(JSON.parse(JSON.stringify(op)))).toEqual(op);
    }
  });

  it("defaults start-task extraEnv to {}", () => {
    const parsed = CtlMessageSchema.parse({
      op: "start-task",
      taskId: "t1",
      harnessId: "opencode",
      cwd: "/w",
    });
    expect(parsed).toEqual(
      expect.objectContaining({ op: "start-task", extraEnv: {} }),
    );
  });

  it("rejects unknown channels and malformed envelopes", () => {
    expect(InnerFrameSchema.safeParse({ ch: "smtp", data: 1 }).success).toBe(
      false,
    );
    expect(
      TunnelEnvelopeSchema.safeParse({ v: 2, t: "hello", challenge: "x" })
        .success,
    ).toBe(false);
    expect(
      TunnelEnvelopeSchema.safeParse({ v: 1, t: "frame", seq: -1, payload: "" })
        .success,
    ).toBe(false);
  });
});
