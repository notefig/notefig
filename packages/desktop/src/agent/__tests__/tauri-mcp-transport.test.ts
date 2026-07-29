import { describe, expect, it } from "vitest";
import { withMockedTauri } from "@/testing/tauri-mock";
import { TauriMcpTransport } from "../tauri-mcp-transport";

const flush = () => new Promise((r) => setTimeout(r, 0));

const relayOk = {
  ok: true,
  value: {
    port: 9000,
    command: "metrists",
    args: ["mcp-relay"],
    token: "tok_abc",
  },
};

describe("TauriMcpTransport", () => {
  it("runs the start → incoming line → respond → stop lifecycle over IPC", async () => {
    const tauri = withMockedTauri({
      start_mcp_relay: () => relayOk,
      write_mcp_line: () => ({ ok: true }),
      stop_mcp_relay: () => ({ ok: true }),
    });

    const transport = new TauriMcpTransport("task_1");
    const requests: string[] = [];
    let capturedRespond: ((line: string) => void) | undefined;
    transport.onRequest((line, respond) => {
      requests.push(line);
      capturedRespond = respond;
    });

    await transport.start();

    expect(tauri.calls("start_mcp_relay")).toEqual([{ taskId: "task_1" }]);
    // The relay descriptor carries the per-task token as env for the harness.
    expect(transport.mcpServer).toMatchObject({
      command: "metrists",
      env: [{ name: "METRISTS_MCP_TOKEN", value: "tok_abc" }],
    });

    // An emitted bridge batch reaches onRequest per line, each with a respond
    // bound to its originating connection (line_pump.rs coalesces; the
    // transport re-expands).
    tauri.emit("mcp-bridge://task_1/lines", {
      connId: 7,
      lines: ['{"id":1}', '{"id":2}'],
    });
    expect(requests).toEqual(['{"id":1}', '{"id":2}']);

    capturedRespond?.('{"result":"ok"}');
    await flush();
    expect(tauri.calls("write_mcp_line")).toEqual([
      { taskId: "task_1", connId: 7, line: '{"result":"ok"}' },
    ]);

    await transport.close();
    expect(tauri.calls("stop_mcp_relay")).toEqual([{ taskId: "task_1" }]);

    // After close, an emitted line no longer produces a write (listeners torn
    // down; writeTo short-circuits on closed). Must use the SAME topic the
    // transport subscribes to — emitting on a topic nobody listens to would
    // pass here even if teardown were broken.
    tauri.emit("mcp-bridge://task_1/lines", { connId: 7, lines: ["late"] });
    await flush();
    expect(tauri.calls("write_mcp_line")).toHaveLength(1);
  });

  it("surfaces a start_mcp_relay rejection as spawn_failed", async () => {
    withMockedTauri({
      start_mcp_relay: () => {
        throw new Error("EADDRINUSE: port busy");
      },
    });

    const transport = new TauriMcpTransport("task_2");
    await expect(transport.start()).rejects.toMatchObject({
      name: "AgentTransportError",
      type: "spawn_failed",
    });
    await expect(transport.start()).rejects.toThrow(/EADDRINUSE/);
  });

  it("treats a non-ok relay result as a start failure", async () => {
    withMockedTauri({
      start_mcp_relay: () => ({
        ok: false,
        error: { proc_id: "task_3", type: "bind", message: "cannot bind" },
      }),
    });

    const transport = new TauriMcpTransport("task_3");
    await expect(transport.start()).rejects.toThrow(/cannot bind/);
  });
});
