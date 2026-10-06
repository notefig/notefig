/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Part 5 lifecycle: a tunnel drop behaves exactly like a desktop workspace
 * close — sessionful tasks demote to "restored" (not "error"), session-less
 * tasks purge, and the remote workspace unregisters so later fs calls fail
 * cleanly. Uses the connect-flow's real disconnect wiring over a FakeWorker.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BUILT_IN_HARNESSES } from "@notefig/shared/agent";
import type { AgentTask } from "../../agent-service";
import { testAgents, type TestAgents } from "@/testing/test-agents";
import { testKv } from "@/testing/test-kv";
import { createTunnelPairing } from "../connect-flow";
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

let agents: TestAgents;
let tunnel: ReturnType<typeof createTunnelPairing>;

beforeEach(() => {
  agents = testAgents();
  // The pairing as the tunnel module builds it: a drop disposes every task.
  tunnel = createTunnelPairing({
    kv: testKv(),
    connection: tunnelConnection,
    onDisconnect: () => agents.runtime.disposeAll(),
  });
});

async function connect(worker: FakeWorker) {
  (tunnelConnection as any).socketFactory = worker.socketFactory;
  await tunnel.connect(encodePairingCode(worker.secret, "wss://fake"));
}

describe("tunnel lifecycle", () => {
  it("demotes a sessionful task to restored on disconnect (not error)", async () => {
    const worker = new FakeWorker({ workspacePath: WORKSPACE });
    await connect(worker);

    const task =
      agents.runtime.managerFor(WORKSPACE).createTask(claudeHarness);
    await task.start(tunnelFactory(task));
    await vi.waitFor(() => {
      expect(agents.store.tasks.get(task.taskId)?.sessionId).toBeTruthy();
    });

    worker.dropConnection();

    await vi.waitFor(() => {
      const row = agents.store.tasks.get(task.taskId);
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

    const task =
      agents.runtime.managerFor(WORKSPACE).createTask(claudeHarness);
    // start() rejects (spawn error) → row exists but never got a sessionId.
    await task.start(tunnelFactory(task)).catch(() => undefined);
    expect(agents.store.tasks.get(task.taskId)?.sessionId).toBeFalsy();

    worker.dropConnection();
    await vi.waitFor(() => {
      expect(tunnelConnection.getState().status).toBe("disconnected");
      // Session-less rows can't revive → purged, not left as a ghost.
      expect(agents.store.tasks.get(task.taskId)).toBeUndefined();
    });
  });
});
