import { describe, expect, it, vi } from "vitest";
import { withMockedTauri } from "@/testing/tauri-mock";
import { TauriStdioTransport, type SpawnAgentOptions } from "../tauri-stdio-transport";
import { AgentTransportError } from "../agent-transport.interface";

// Flush the microtask queue so the transport's promise-chained stdin writes and
// invoke round-trips settle before we assert.
const flush = () => new Promise((r) => setTimeout(r, 0));

const OPTIONS: SpawnAgentOptions = {
  procId: "p1",
  program: "claude",
  args: ["acp"],
  cwd: "/ws",
  env: { PATH: "/usr/bin" },
};

const spawnOk = { ok: true, value: { pid: 4242, resolvedPath: "/usr/bin/claude" } };

describe("TauriStdioTransport", () => {
  it("runs the spawn → stdout → write → exit lifecycle through the real IPC seam", async () => {
    const tauri = withMockedTauri({
      spawn_agent: () => spawnOk,
      write_agent_stdin: () => ({ ok: true }),
      kill_agent: () => ({ ok: true }),
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

    // Emitted stdout/stderr reach the right callbacks (proves listeners were
    // registered before spawn and are wired to the module's fan-out).
    tauri.emit("agent-proc://p1/stdout-line", '{"jsonrpc":"2.0"}');
    tauri.emit("agent-proc://p1/stderr-line", "a warning");
    expect(lines).toEqual(['{"jsonrpc":"2.0"}']);
    expect(diagnostics).toEqual(["a warning"]);

    // send() writes stdin through the write_agent_stdin command.
    transport.send("a line");
    await flush();
    expect(tauri.calls("write_agent_stdin")).toEqual([
      { procId: "p1", line: "a line" },
    ]);

    // A non-zero exit event drives onClose with an error and tears listeners
    // down — the lifecycle depends on the emitted event, not a return value.
    tauri.emit("agent-proc://p1/exit", { code: 1 });
    expect(closes).toHaveLength(1);
    expect(closes[0]).toBeInstanceOf(AgentTransportError);
    expect(closes[0]?.message).toMatch(/code 1/);

    // Post-exit, listeners are gone: further stdout must not reach onLine.
    tauri.emit("agent-proc://p1/stdout-line", "after exit");
    expect(lines).toEqual(['{"jsonrpc":"2.0"}']);
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
