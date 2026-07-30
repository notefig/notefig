import { describe, expect, it, vi } from "vitest";
import { withMockedTauri } from "@/testing/tauri-mock";
import { TauriStdioTransport, type SpawnAgentOptions } from "../tauri-stdio-transport";
import { AgentTransportError } from "../agent-transport.interface";
import type { PullResult } from "../stream-puller";

// Flush the microtask queue so the transport's promise-chained stdin writes and
// doorbell-driven pull loops settle before we assert.
const flush = () => new Promise((r) => setTimeout(r, 0));

const OPTIONS: SpawnAgentOptions = {
  procId: "p1",
  program: "claude",
  args: ["acp"],
  cwd: "/ws",
  env: { PATH: "/usr/bin" },
};

const spawnOk = { ok: true, value: { pid: 4242, resolvedPath: "/usr/bin/claude" } };

/** Rust-side stand-in: per-stream FIFO of pull responses (line_stream.rs).
 * An exhausted stream reports empty-and-not-ended, like a drained queue. */
function pullQueues(queues: Record<string, PullResult[]>) {
  return ({ streamId }: Record<string, unknown>): PullResult =>
    queues[streamId as string]?.shift() ?? { lines: [], ended: false };
}

describe("TauriStdioTransport", () => {
  it("runs the spawn → doorbell → pull → write → exit lifecycle through the real IPC seam", async () => {
    const queues: Record<string, PullResult[]> = {
      "agent-proc://p1/stdout": [],
      "agent-proc://p1/stderr": [],
    };
    const tauri = withMockedTauri({
      spawn_agent: () => spawnOk,
      write_agent_stdin: () => ({ ok: true }),
      kill_agent: () => ({ ok: true }),
      pull_stream_lines: pullQueues(queues),
    });

    const transport = new TauriStdioTransport(OPTIONS);
    const lines: string[] = [];
    const diagnostics: string[] = [];
    const closes: Array<AgentTransportError | undefined> = [];
    transport.onLine((line) => lines.push(line));
    transport.onDiagnostic((line) => diagnostics.push(line));
    transport.onClose((error) => closes.push(error));

    await transport.start();

    // The right command + payload went out for spawn.
    expect(tauri.calls("spawn_agent")).toEqual([
      expect.objectContaining({ procId: "p1", program: "claude", cwd: "/ws" }),
    ]);
    expect(transport.spawnInfo).toMatchObject({ pid: 4242, program: "claude" });

    // Doorbells carry no lines; the transport pulls them (proves listeners
    // were registered before spawn and the pull loop fans out per line, in
    // order — the ACP layer above never sees streams or batching).
    queues["agent-proc://p1/stdout"].push({
      lines: ['{"jsonrpc":"2.0"}', '{"id":1}'],
      ended: false,
    });
    queues["agent-proc://p1/stderr"].push({ lines: ["a warning"], ended: false });
    tauri.emit("agent-proc://p1/stdout-doorbell");
    tauri.emit("agent-proc://p1/stderr-doorbell");
    await flush();
    expect(lines).toEqual(['{"jsonrpc":"2.0"}', '{"id":1}']);
    expect(diagnostics).toEqual(["a warning"]);

    // send() writes stdin through the write_agent_stdin command.
    transport.send("a line");
    await flush();
    expect(tauri.calls("write_agent_stdin")).toEqual([
      { procId: "p1", line: "a line" },
    ]);

    // A non-zero exit closes with an error once the stdout stream has ended.
    queues["agent-proc://p1/stdout"].push({ lines: [], ended: true });
    tauri.emit("agent-proc://p1/exit", { code: 1 });
    await flush();
    expect(closes).toHaveLength(1);
    expect(closes[0]).toBeInstanceOf(AgentTransportError);
    expect(closes[0]?.message).toMatch(/code 1/);

    // Post-exit, pullers and listeners are gone: a doorbell must not pull.
    const pullsBefore = tauri.calls("pull_stream_lines").length;
    tauri.emit("agent-proc://p1/stdout-doorbell");
    await flush();
    expect(tauri.calls("pull_stream_lines")).toHaveLength(pullsBefore);
  });

  it("delivers the stdout tail before closing when exit races the final pulls", async () => {
    // The exit event arrives while the last lines of the turn are still
    // queued Rust-side. Closing immediately would lose them — the transport
    // must drain to `ended` first. (This race was benign under the old
    // push model because lines and exit shared one ordered channel; pulls
    // are out-of-band, so the ordering is now the transport's job.)
    const queues: Record<string, PullResult[]> = {
      "agent-proc://p1/stdout": [
        { lines: ['{"final":"result"}'], ended: true },
      ],
    };
    const tauri = withMockedTauri({
      spawn_agent: () => spawnOk,
      pull_stream_lines: pullQueues(queues),
    });

    const transport = new TauriStdioTransport(OPTIONS);
    const lines: string[] = [];
    const closes: Array<AgentTransportError | undefined> = [];
    transport.onLine((line) => lines.push(line));
    transport.onClose((error) => closes.push(error));

    await transport.start();

    tauri.emit("agent-proc://p1/exit", { code: 0 });
    await flush();

    expect(lines).toEqual(['{"final":"result"}']);
    expect(closes).toHaveLength(1);
    expect(closes[0]).toBeUndefined();
  });

  it("surfaces a spawn_agent rejection as a spawn_failed error, not a hang", async () => {
    withMockedTauri({
      spawn_agent: () => {
        throw new Error("ENOENT: no such binary");
      },
    });

    const transport = new TauriStdioTransport(OPTIONS);
    const closes: Array<AgentTransportError | undefined> = [];
    transport.onClose((error) => closes.push(error));

    await expect(transport.start()).rejects.toMatchObject({
      name: "AgentTransportError",
      type: "spawn_failed",
    });
    await expect(transport.start()).rejects.toThrow(/ENOENT/);
  });

  it("send() after close throws instead of writing", async () => {
    withMockedTauri({
      spawn_agent: () => spawnOk,
      kill_agent: () => ({ ok: true }),
      write_agent_stdin: vi.fn(() => ({ ok: true })),
    });

    const transport = new TauriStdioTransport(OPTIONS);
    await transport.start();
    await transport.close();

    expect(() => transport.send("nope")).toThrow(AgentTransportError);
  });
});
