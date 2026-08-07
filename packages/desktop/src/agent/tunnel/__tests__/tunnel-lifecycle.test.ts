/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Part 5 lifecycle: a tunnel drop behaves exactly like a desktop workspace
 * close — sessionful tasks demote to "restored" (not "error"), session-less
 * tasks purge, and the remote workspace unregisters so later fs calls fail
 * cleanly. Uses the connect-flow's real disconnect wiring over a FakeWorker.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { kv } = vi.hoisted(() => ({ kv: new Map<string, unknown>() }));

vi.mock("@/adapters", () => ({
  platformAdapter: {
    getKv: vi.fn(async (ns: string, key: string) => kv.get(`${ns}:${key}`)),
    setKv: vi.fn(async (ns: string, key: string, value: unknown) => {
      kv.set(`${ns}:${key}`, value);
    }),
    deleteKv: vi.fn(async (ns: string, key: string) => kv.delete(`${ns}:${key}`)),
    getAllKv: vi.fn(async () => ({})),
    writeFiles: vi.fn(async (files: any[]) => ({
      succeeded: files.map((f) => f.path),
      failed: [],
    })),
    readFiles: vi.fn(async (paths: string[]) => ({
      succeeded: paths.map((p) => ({ path: p, content: "" })),
      failed: [],
    })),
    deleteFiles: vi.fn(async (paths: string[]) => ({
      succeeded: paths,
      failed: [],
    })),
    createMcpEndpoint: vi.fn(() => ({
      mcpServer: { name: "notefig", command: "m", args: [], env: [] },
      start: vi.fn(async () => {}),
      onRequest: vi.fn(() => () => {}),
      close: vi.fn(async () => {}),
    })),
  },
}));
vi.mock("@/utils/history-service", () => ({
  checkpointWorkspaceHistory: vi.fn().mockResolvedValue(null),
}));

import { BUILT_IN_HARNESSES } from "@notefig/shared/agent";
import {
  agentEntriesCollection,
  agentPermissionRequestsCollection,
  agentTasksCollection,
  agentTurnsCollection,
} from "../../agent-collections";
import {
  getOrCreateWorkspaceTaskManager,
  type AgentTask,
} from "../../agent-service";
import { connectWithCode } from "../connect-flow";
import { tunnelConnection } from "../tunnel-connection";
import { TunnelTransport } from "../tunnel-transport";
import { FakeWorker } from "./fake-worker";
import { encodePairingCode } from "@notefig/shared/tunnel";

const claudeHarness = BUILT_IN_HARNESSES.find((h) => h.id === "claude-code")!;
const WORKSPACE = "/remote/ws";

function tunnelFactory(task: AgentTask) {
  return ({ extraEnv }: { extraEnv: Record<string, string> }) =>
    new TunnelTransport(
      {
        taskId: task.taskId,
        harness: task.harness,
        workspacePath: task.workspacePath,
        extraEnv,
      },
      tunnelConnection,
    );
}

beforeEach(() => {
  kv.clear();
  for (const e of agentEntriesCollection.toArray) agentEntriesCollection.delete(e.id);
  for (const t of agentTurnsCollection.toArray) agentTurnsCollection.delete(t.turnId);
  for (const t of agentTasksCollection.toArray) agentTasksCollection.delete(t.taskId);
  for (const r of agentPermissionRequestsCollection.toArray)
    agentPermissionRequestsCollection.delete(r.id);
});

async function connect(worker: FakeWorker) {
  (tunnelConnection as any).socketFactory = worker.socketFactory;
  await connectWithCode(encodePairingCode(worker.secret, "wss://fake"));
}

describe("tunnel lifecycle", () => {
  it("demotes a sessionful task to restored on disconnect (not error)", async () => {
    const worker = new FakeWorker({ workspacePath: WORKSPACE });
    await connect(worker);

    const task = getOrCreateWorkspaceTaskManager(WORKSPACE).createTask(claudeHarness);
    await task.start(tunnelFactory(task));
    await vi.waitFor(() => {
      expect(agentTasksCollection.get(task.taskId)?.sessionId).toBeTruthy();
    });

    worker.dropConnection();

    await vi.waitFor(() => {
      const row = agentTasksCollection.get(task.taskId);
      expect(row?.status).toBe("restored");
    });
    expect(tunnelConnection.getState().status).toBe("disconnected");
  });

  it("purges a session-less task on disconnect", async () => {
    const worker = new FakeWorker({
      workspacePath: WORKSPACE,
      spawnError: { harnessId: "claude-code", message: "no session yet" },
    });
    await connect(worker);

    const task = getOrCreateWorkspaceTaskManager(WORKSPACE).createTask(claudeHarness);
    // start() rejects (spawn error) → row exists but never got a sessionId.
    await task.start(tunnelFactory(task)).catch(() => undefined);
    expect(agentTasksCollection.get(task.taskId)?.sessionId).toBeFalsy();

    worker.dropConnection();
    await vi.waitFor(() => {
      expect(tunnelConnection.getState().status).toBe("disconnected");
      // Session-less rows can't revive → purged, not left as a ghost.
      expect(agentTasksCollection.get(task.taskId)).toBeUndefined();
    });
  });
});
