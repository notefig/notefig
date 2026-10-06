/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Transport symmetry: the agent-service turn machinery runs over
 * TunnelTransport / TunnelMcpEndpoint against the FakeWorker exactly as it
 * runs over the loopback transport on desktop — same FakeAgent scripting,
 * zero new protocol assertions in the task layer. Also covers the pieces
 * only the tunnel has: spawn errors over ctl, task-exit close semantics,
 * the OPENCODE_CONFIG_CONTENT env landing on the worker, session/load
 * revival, and the disconnect pipeline ordering (dispose before transport
 * onClose).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BUILT_IN_HARNESSES } from "@notefig/shared/agent";
import { AgentTransportError, type McpEndpoint } from "@notefig/agent";
import {
  TaskManager,
  type AgentRuntimeDeps,
  type AgentTask,
} from "../../agent-service";
import {
  fakeMcpEndpoint,
  testAgents,
  type TestAgents,
} from "@/testing/test-agents";
import { TunnelConnection } from "../tunnel-connection";
import { TunnelTransport } from "../tunnel-transport";
import { TunnelMcpEndpoint } from "../tunnel-mcp-endpoint";
import { FakeWorker } from "./fake-worker";

/** The browser's own fs (this is where writeFiles lands now — files no
 *  longer cross the tunnel). Kept per-test. */
let fsFiles: Map<string, string>;
/** The MCP endpoint a task opens: the tunnel's once a pair connects. */
let createMcpEndpoint: ((spec: { taskId: string }) => McpEndpoint) | null;
let agents: TestAgents;

const fs: AgentRuntimeDeps["fs"] = {
  writeFiles: async (files) => {
    for (const file of files) fsFiles.set(file.path, file.content);
    return { succeeded: files.map((f) => f.path), failed: [] };
  },
  readFiles: async (paths) => ({
    succeeded: paths.map((p) => ({ path: p, content: fsFiles.get(p) ?? "" })),
    failed: [],
  }),
};

const claudeHarness = BUILT_IN_HARNESSES.find((h) => h.id === "claude-code")!;
const opencodeHarness = BUILT_IN_HARNESSES.find((h) => h.id === "opencode")!;
const WORKSPACE = "/remote/ws";

function entriesFor(taskId: string) {
  return agents.store.entries.toArray
    .filter((e) => e.taskId === taskId)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

function textFor(taskId: string, role: "user" | "assistant"): string {
  return entriesFor(taskId)
    .filter((e) => e.type === role)
    .map((e) => e.text ?? "")
    .join("");
}

function turnsFor(taskId: string) {
  return agents.store.turns.toArray
    .filter((t) => t.taskId === taskId)
    .sort((a, b) => (a.turnId < b.turnId ? -1 : 1));
}

async function runPrompt(task: AgentTask, text: string): Promise<void> {
  const before = turnsFor(task.taskId).length;
  task.prompt(text);
  await vi.waitFor(() => {
    const turns = turnsFor(task.taskId);
    expect(turns.length).toBe(before + 1);
    expect(["completed", "error", "cancelled"]).toContain(
      turns[turns.length - 1].status,
    );
  });
}

/** Connect a fresh TunnelConnection to a fresh FakeWorker. */
async function connectedPair(
  workerOptions: ConstructorParameters<typeof FakeWorker>[0] = {},
) {
  const worker = new FakeWorker({ workspacePath: WORKSPACE, ...workerOptions });
  const connection = new TunnelConnection(worker.socketFactory);
  await connection.connect({ secret: worker.secret, url: "wss://fake" });
  createMcpEndpoint = (spec) =>
    new TunnelMcpEndpoint(spec.taskId, connection);
  return { worker, connection };
}

function tunnelFactory(connection: TunnelConnection, task: AgentTask) {
  return ({ extraEnv }: { extraEnv: Record<string, string> }) =>
    new TunnelTransport(
      {
        taskId: task.taskId,
        harness: task.harness,
        workspacePath: task.workspacePath,
        extraEnv,
      },
      connection,
    );
}

beforeEach(() => {
  fsFiles = new Map();
  createMcpEndpoint = null;
  agents = testAgents({
    fs,
    proc: {
      createMcpEndpoint: (spec) =>
        createMcpEndpoint ? createMcpEndpoint(spec) : fakeMcpEndpoint(),
      createAgentTransport: () => {
        throw new Error("tasks start over the tunnel transport");
      },
    },
  });
});

describe("tunnel transport symmetry", () => {
  it("streams and coalesces an assistant turn over the tunnel", async () => {
    const { worker, connection } = await connectedPair({
      configureAgent: (agent) => {
        agent.onPrompt = async (_params, a) => {
          a.update("sess_test", {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Hello " },
          });
          a.update("sess_test", {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "tunnel" },
          });
          return { stopReason: "end_turn" };
        };
      },
    });

    const task = new TaskManager(agents.deps, WORKSPACE).createTask(claudeHarness);
    await task.start(tunnelFactory(connection, task));
    await runPrompt(task, "hi");

    expect(textFor(task.taskId, "user")).toBe("hi");
    expect(textFor(task.taskId, "assistant")).toContain("Hello tunnel");
    expect(turnsFor(task.taskId)[0].status).toBe("completed");
    expect(worker.receivedCtl.some((m) => m.op === "start-task")).toBe(true);
  });

  it("uses the worker's real path as the ACP session cwd (not the browser path)", async () => {
    // The browser addresses files by its own fs-adapter path; the agent runs
    // on the worker and validates cwd there, so session/new must carry the
    // worker's --dir (pair-ack), never the browser workspace path.
    let captured: any = null;
    const { connection } = await connectedPair({
      workspacePath: "/worker/real-dir",
      configureAgent: (agent) => {
        agent.onPrompt = async (_p, _a) => {
          captured = agent.newSessionParams;
          return { stopReason: "end_turn" };
        };
      },
    });

    const task = new TaskManager(agents.deps, "/browser-synthetic").createTask(
      claudeHarness,
    );
    await task.start(tunnelFactory(connection, task));
    await runPrompt(task, "hi");

    expect(captured?.cwd).toBe("/worker/real-dir");
  });

  it("carries OPENCODE_CONFIG_CONTENT onto the worker: inline config in spawn env, no file", async () => {
    const { worker, connection } = await connectedPair();

    const task = new TaskManager(agents.deps, WORKSPACE).createTask(opencodeHarness);
    await task.start(tunnelFactory(connection, task));

    const startTask = worker.receivedCtl.find(
      (m): m is Extract<typeof m, { op: "start-task" }> =>
        m.op === "start-task",
    )!;
    // Inline JSON, not a path: the worker applies its generic env rewrite,
    // which passes it through untouched — the embedded relay command already
    // arrived worker-local via the mcp-opened spec.
    const config = JSON.parse(startTask.extraEnv.OPENCODE_CONFIG_CONTENT);
    expect(config.mcp.notefig.command).toEqual([
      "/usr/bin/node",
      "/worker/cli.js",
      "mcp-relay",
      "--port",
      "12345",
    ]);
    expect(config.mcp.notefig.environment.NOTEFIG_MCP_TOKEN).toBe("fake-token");
    expect(startTask.extraEnv.OPENCODE_CONFIG).toBeUndefined();
    expect(fsFiles.size).toBe(0);
  });

  it("answers MCP request lines from a harness relay connection (connId routing)", async () => {
    const { worker, connection } = await connectedPair();

    const task = new TaskManager(agents.deps, WORKSPACE).createTask(claudeHarness);
    await task.start(tunnelFactory(connection, task));

    const relayA = worker.mcpConnect(task.taskId);
    const relayB = worker.mcpConnect(task.taskId);
    relayA.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }));
    relayB.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }));

    await vi.waitFor(() => {
      expect(relayA.received).toHaveLength(1);
      expect(relayB.received).toHaveLength(1);
    });
    expect(JSON.parse(relayA.received[0]).id).toBe(1);
    expect(JSON.parse(relayB.received[0]).id).toBe(2);
  });

  it("surfaces worker spawn errors as an errored task", async () => {
    const { connection } = await connectedPair({
      spawnError: {
        harnessId: "claude-code",
        message: "command not found: npx",
      },
    });

    const task = new TaskManager(agents.deps, WORKSPACE).createTask(claudeHarness);
    await expect(task.start(tunnelFactory(connection, task))).rejects.toThrow(
      "command not found",
    );
    expect(agents.store.tasks.get(task.taskId)?.status).toBe("error");
  });

  it("task-exit closes the transport with desktop-identical semantics", async () => {
    const { worker, connection } = await connectedPair();
    const task = new TaskManager(agents.deps, WORKSPACE).createTask(claudeHarness);
    await task.start(tunnelFactory(connection, task));

    worker.exitTask(task.taskId, 1);
    await vi.waitFor(() => {
      expect(agents.store.tasks.get(task.taskId)?.status).toBe("error");
    });
  });

  it("revives a restored session via session/load over the tunnel", async () => {
    const { connection } = await connectedPair({
      configureAgent: (agent) => {
        agent.onLoadSession = async (_params, a) => {
          a.update("sess_restored", {
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: "earlier prompt" },
          });
          a.update("sess_restored", {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "earlier answer" },
          });
          return {};
        };
      },
    });

    const manager = new TaskManager(agents.deps, WORKSPACE);
    const task = manager.createTask(claudeHarness);
    await task.start(tunnelFactory(connection, task), {
      resumeSessionId: "sess_restored",
    });

    await vi.waitFor(() => {
      expect(textFor(task.taskId, "assistant")).toContain("earlier answer");
      expect(textFor(task.taskId, "user")).toContain("earlier prompt");
    });
  });

  it("runs the disconnect pipeline before transport close listeners", async () => {
    const { worker, connection } = await connectedPair();
    const order: string[] = [];
    connection.onDisconnect(async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push("dispose");
    });
    connection.onClosed(() => order.push("transport-close"));

    const task = new TaskManager(agents.deps, WORKSPACE).createTask(claudeHarness);
    await task.start(tunnelFactory(connection, task));

    worker.dropConnection();
    await vi.waitFor(() => {
      expect(order).toEqual(["dispose", "transport-close"]);
      expect(connection.getState().status).toBe("disconnected");
    });
  });

  it("fails pairing cleanly with a wrong secret", async () => {
    const worker = new FakeWorker({ workspacePath: WORKSPACE });
    const connection = new TunnelConnection(worker.socketFactory);
    const wrongSecret = new Uint8Array(32).fill(9);
    await expect(
      connection.connect({ secret: wrongSecret, url: "wss://fake" }),
    ).rejects.toMatchObject({ type: "pairing_failed" });
    expect(connection.getState().status).toBe("disconnected");
  });

  it("rejects a protocol-version-mismatched worker", async () => {
    const worker = new FakeWorker({ workspacePath: WORKSPACE, protocol: 99 });
    const connection = new TunnelConnection(worker.socketFactory);
    await expect(
      connection.connect({ secret: worker.secret, url: "wss://fake" }),
    ).rejects.toThrow("protocol mismatch");
  });

  it("start() without a connection fails as relay_unreachable", async () => {
    const connection = new TunnelConnection(() => {
      throw new Error("should not dial");
    });
    const transport = new TunnelTransport(
      {
        taskId: "t1",
        harness: claudeHarness,
        workspacePath: WORKSPACE,
        extraEnv: {},
      },
      connection,
    );
    await expect(transport.start()).rejects.toMatchObject({
      type: "relay_unreachable",
    } satisfies Partial<AgentTransportError>);
  });
});
