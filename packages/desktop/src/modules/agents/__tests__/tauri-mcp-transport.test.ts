import { describe, expect, it } from "vitest";
import { withMockedTauri } from "@/testing/tauri-mock";
import { TauriMcpTransport } from "../tauri-mcp-transport";
import type { PullResult } from "../stream-puller";

const flush = () => new Promise((r) => setTimeout(r, 0));

const relayOk = {
  ok: true,
  value: {
    port: 9000,
    command: "notefig",
    args: ["mcp-relay"],
    token: "tok_abc",
  },
};

/** Rust-side stand-in: per-stream FIFO of pull responses (line_stream.rs). */
function pullQueues(queues: Record<string, PullResult[]>) {
  return ({ streamId }: Record<string, unknown>): PullResult =>
    queues[streamId as string]?.shift() ?? { lines: [], ended: false };
}

describe("TauriMcpTransport", () => {
  it("runs the start → doorbell → pull → respond → stop lifecycle over IPC", async () => {
    const queues: Record<string, PullResult[]> = {
      "mcp-bridge://task_1/7": [],
    };
    const tauri = withMockedTauri({
      start_mcp_relay: () => relayOk,
      write_mcp_line: () => ({ ok: true }),
      stop_mcp_relay: () => ({ ok: true }),
      pull_stream_lines: pullQueues(queues),
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
      command: "notefig",
      env: [{ name: "NOTEFIG_MCP_TOKEN", value: "tok_abc" }],
    });

    // The doorbell names only the connection; lines arrive via pulls, each
    // reaching onRequest with a respond bound to that connection.
    queues["mcp-bridge://task_1/7"].push({
      lines: ['{"id":1}', '{"id":2}'],
      ended: false,
    });
    tauri.emit("mcp-bridge://task_1/doorbell", { connId: 7 });
    await flush();
    expect(requests).toEqual(['{"id":1}', '{"id":2}']);

    capturedRespond?.('{"result":"ok"}');
    await flush();
    expect(tauri.calls("write_mcp_line")).toEqual([
      { taskId: "task_1", connId: 7, line: '{"result":"ok"}' },
    ]);

    await transport.close();
    expect(tauri.calls("stop_mcp_relay")).toEqual([{ taskId: "task_1" }]);

    // After close, a doorbell no longer pulls (listener torn down, pullers
    // stopped). Must use the SAME topic the transport subscribes to —
    // emitting on a topic nobody listens to would pass here even if
    // teardown were broken.
    const pullsBefore = tauri.calls("pull_stream_lines").length;
    queues["mcp-bridge://task_1/7"].push({ lines: ["late"], ended: false });
    tauri.emit("mcp-bridge://task_1/doorbell", { connId: 7 });
    await flush();
    expect(tauri.calls("pull_stream_lines")).toHaveLength(pullsBefore);
    expect(requests).toEqual(['{"id":1}', '{"id":2}']);
  });

  it("keeps connections independent: one ending is routine churn, not endpoint death", async () => {
    const queues: Record<string, PullResult[]> = {
      "mcp-bridge://task_1/1": [{ lines: ['{"from":1}'], ended: true }],
      "mcp-bridge://task_1/2": [{ lines: ['{"from":2}'], ended: false }],
    };
    const tauri = withMockedTauri({
      start_mcp_relay: () => relayOk,
      pull_stream_lines: pullQueues(queues),
    });

    const transport = new TauriMcpTransport("task_1");
    const requests: string[] = [];
    transport.onRequest((line) => requests.push(line));
    await transport.start();

    // Connection 1 delivers its line and ends; connection 2 stays live.
    tauri.emit("mcp-bridge://task_1/doorbell", { connId: 1 });
    tauri.emit("mcp-bridge://task_1/doorbell", { connId: 2 });
    await flush();
    expect(requests).toEqual(['{"from":1}', '{"from":2}']);

    // A fresh doorbell for the ended connection makes a NEW puller (the old
    // one is gone) — and one for the live connection keeps pulling.
    queues["mcp-bridge://task_1/1"].push({ lines: ['{"respawned":1}'], ended: false });
    tauri.emit("mcp-bridge://task_1/doorbell", { connId: 1 });
    await flush();
    expect(requests).toContain('{"respawned":1}');
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
