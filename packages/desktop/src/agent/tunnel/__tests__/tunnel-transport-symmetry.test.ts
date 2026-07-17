/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Transport symmetry: the agent-service turn machinery runs over
 * TunnelTransport / TunnelMcpEndpoint against the FakeWorker exactly as it
 * runs over the loopback transport on desktop — same FakeAgent scripting,
 * zero new protocol assertions in the task layer. Also covers the pieces
 * only the tunnel has: spawn errors over ctl, task-exit close semantics,
 * the OPENCODE_CONFIG write landing on the worker, session/load revival,
 * and the disconnect pipeline ordering (dispose before transport onClose).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => {
  const mocks = {
    /** The browser's own fs (this is where writeFiles lands now — files no
     *  longer cross the tunnel). Kept per-test. */
    fsFiles: new Map<string, string>(),
    createMcpEndpoint: null as ((spec: { taskId: string }) => any) | null,
  };
  return { mocks };
});

vi.mock("@/adapters", () => ({
  platformAdapter: {
    setKv: vi.fn(),
    getKv: vi.fn(),
    getAllKv: vi.fn(async () => ({})),
    deleteKv: vi.fn(),
    writeFiles: vi.fn(async (files: { path: string; content: string }[]) => {
      for (const file of files) mocks.fsFiles.set(file.path, file.content);
      return { succeeded: files.map((f) => f.path), failed: [] as unknown[] };
    }),
    readFiles: vi.fn(async (paths: string[]) => ({
      succeeded: paths.map((p) => ({
        path: p,
        content: mocks.fsFiles.get(p) ?? "",
      })),
      failed: [] as unknown[],
    })),
    deleteFiles: vi.fn(async (paths: string[]) => {
      for (const path of paths) mocks.fsFiles.delete(path);
      return { succeeded: paths, failed: [] as unknown[] };
    }),
    createMcpEndpoint: vi.fn((spec: { taskId: string }) =>
      mocks.createMcpEndpoint
        ? mocks.createMcpEndpoint(spec)
        : {
            mcpServer: { name: "metrists", command: "m", args: [], env: [] },
            start: vi.fn(async () => {}),
            onRequest: vi.fn(() => () => {}),
            close: vi.fn(async () => {}),
          },
    ),
  },
}));
vi.mock("@/utils/history-service", () => ({
  checkpointWorkspaceHistory: vi.fn().mockResolvedValue(null),
}));

import { BUILT_IN_HARNESSES } from "@metrists/shared/agent";
import { AgentTransportError } from "../../agent-transport.interface";
import {
  agentEntriesCollection,
  agentPermissionRequestsCollection,
  agentTasksCollection,
  agentTurnsCollection,
} from "../../agent-collections";
import { TaskManager, type AgentTask } from "../../agent-service";
import { TunnelConnection } from "../tunnel-connection";
import { TunnelTransport } from "../tunnel-transport";
import { TunnelMcpEndpoint } from "../tunnel-mcp-endpoint";
import { FakeWorker } from "./fake-worker";

const claudeHarness = BUILT_IN_HARNESSES.find((h) => h.id === "claude-code")!;
const opencodeHarness = BUILT_IN_HARNESSES.find((h) => h.id === "opencode")!;
const WORKSPACE = "/remote/ws";

function entriesFor(taskId: string) {
  return agentEntriesCollection.toArray
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
  return agentTurnsCollection.toArray
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
async function connectedPair(workerOptions: ConstructorParameters<typeof FakeWorker>[0] = {}) {
  const worker = new FakeWorker({ workspacePath: WORKSPACE, ...workerOptions });
  const connection = new TunnelConnection(worker.socketFactory);
  await connection.connect({ secret: worker.secret, url: "wss://fake" });
  mocks.createMcpEndpoint = (spec) =>
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
  mocks.fsFiles.clear();
  mocks.createMcpEndpoint = null;
  for (const e of agentEntriesCollection.toArray) agentEntriesCollection.delete(e.id);
  for (const t of agentTurnsCollection.toArray) agentTurnsCollection.delete(t.turnId);
  for (const t of agentTasksCollection.toArray) agentTasksCollection.delete(t.taskId);
  for (const r of agentPermissionRequestsCollection.toArray)
    agentPermissionRequestsCollection.delete(r.id);
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

    const task = new TaskManager(WORKSPACE).createTask(claudeHarness);
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

    const task = new TaskManager("/browser-synthetic").createTask(claudeHarness);
    await task.start(tunnelFactory(connection, task));
    await runPrompt(task, "hi");

    expect(captured?.cwd).toBe("/worker/real-dir");
  });

  it("carries OPENCODE_CONFIG onto the worker: config file + spawn env", async () => {
    const { worker, connection } = await connectedPair();

    const task = new TaskManager(WORKSPACE).createTask(opencodeHarness);
    await task.start(tunnelFactory(connection, task));

    const startTask = worker.receivedCtl.find(
      (m): m is Extract<typeof m, { op: "start-task" }> => m.op === "start-task",
    )!;
    const configPath = startTask.extraEnv.OPENCODE_CONFIG;
    expect(configPath).toBe(
      `${WORKSPACE}/.metrists/agent/opencode-${task.taskId}.json`,
    );
    // The config was written by the browser's OWN fs adapter (not over the
    // tunnel); the worker rewrites this browser path to its --dir at spawn.
    const config = JSON.parse(mocks.fsFiles.get(configPath)!);
    expect(config.mcp.metrists.command).toEqual([
      "/usr/bin/node",
      "/worker/cli.js",
      "mcp-relay",
      "--port",
      "12345",
    ]);
    expect(config.mcp.metrists.environment.METRISTS_MCP_TOKEN).toBe("fake-token");
  });

  it("answers MCP request lines from a harness relay connection (connId routing)", async () => {
    const { worker, connection } = await connectedPair();

    const task = new TaskManager(WORKSPACE).createTask(claudeHarness);
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
      spawnError: { harnessId: "claude-code", message: "command not found: npx" },
    });

    const task = new TaskManager(WORKSPACE).createTask(claudeHarness);
    await expect(task.start(tunnelFactory(connection, task))).rejects.toThrow(
      "command not found",
    );
    expect(agentTasksCollection.get(task.taskId)?.status).toBe("error");
  });

  it("task-exit closes the transport with desktop-identical semantics", async () => {
    const { worker, connection } = await connectedPair();
    const task = new TaskManager(WORKSPACE).createTask(claudeHarness);
    await task.start(tunnelFactory(connection, task));

    worker.exitTask(task.taskId, 1);
    await vi.waitFor(() => {
      expect(agentTasksCollection.get(task.taskId)?.status).toBe("error");
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

    const manager = new TaskManager(WORKSPACE);
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

    const task = new TaskManager(WORKSPACE).createTask(claudeHarness);
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
