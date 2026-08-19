import { describe, it, expect, vi } from "vitest";

// acp-client pulls in file-sync → platform adapter, and permission-broker
// reaches the agent collections (which need a db surface at module eval).
// Nothing else on the adapter is exercised by a mock-harness round trip.
vi.mock("@/adapters", async () => ({
  platformAdapter: {
    db: (await import("@/testing/node-db")).createNodeTestDb(),
  },
}));

import { NotefigAcpClient } from "../acp-client";
import type { SessionNotification } from "@notefig/shared/agent";
import { PermissionBroker } from "../permission-broker";
import {
  createMockAgentTransport,
  createMockMcpEndpoint,
  configureMockAgent,
  registerMockScenario,
} from "../mock-harness";

async function connectedClient(onUpdate: (n: SessionNotification) => void) {
  const transport = createMockAgentTransport();
  const client = new NotefigAcpClient({
    taskId: "task_test",
    transport,
    permissionBroker: new PermissionBroker("task_test"),
    onSessionUpdate: onUpdate,
  });
  await transport.start();
  await client.connect();
  const session = await client.newSession("/workspace/mock");
  return { client, sessionId: session.sessionId };
}

describe("mock harness", () => {
  it("plays the configured scenario through the real ACP client", async () => {
    const updates: SessionNotification[] = [];
    const { client, sessionId } = await connectedClient((n) => updates.push(n));
    expect(sessionId).toMatch(/^mock_session_/);

    configureMockAgent({
      scenario: "longTranscript",
      options: { sections: 3, delayMs: 0, chunkSize: 200 },
    });
    const response = await client.prompt(sessionId, [
      { type: "text", text: "go" },
    ]);
    expect(response.stopReason).toBe("end_turn");

    const kinds = updates.map((n) => n.update.sessionUpdate);
    expect(kinds).toContain("agent_message_chunk");
    expect(kinds).toContain("agent_thought_chunk");
    expect(kinds).toContain("tool_call");
    expect(kinds).toContain("tool_call_update");
    expect(kinds).toContain("plan");
    // Every tool call reaches a terminal status.
    const terminal = updates.filter(
      (n) =>
        n.update.sessionUpdate === "tool_call_update" &&
        (n.update as { status?: string }).status === "completed",
    );
    expect(terminal.length).toBe(3);
  });

  it("honors the @@mock: prompt directive for a single turn", async () => {
    const updates: SessionNotification[] = [];
    const { client, sessionId } = await connectedClient((n) => updates.push(n));

    configureMockAgent({ scenario: "echo" });
    const directive = `@@mock:${JSON.stringify({
      scenario: "longTranscript",
      options: { sections: 1, delayMs: 0 },
    })}`;
    await client.prompt(sessionId, [{ type: "text", text: directive }]);
    expect(updates.some((n) => n.update.sessionUpdate === "tool_call")).toBe(
      true,
    );
  });

  it("supports registered custom scenarios (the extension seam)", async () => {
    registerMockScenario("justSayHi", () => async ({ emit }) => {
      emit({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hi" },
      });
      return { stopReason: "end_turn" };
    });
    const updates: SessionNotification[] = [];
    const { client, sessionId } = await connectedClient((n) => updates.push(n));
    configureMockAgent({ scenario: "justSayHi" });
    await client.prompt(sessionId, [{ type: "text", text: "…" }]);
    expect(
      updates
        .filter((n) => n.update.sessionUpdate === "agent_message_chunk")
        .map((n) => (n.update as { content: { text: string } }).content.text),
    ).toEqual(["hi"]);
  });

  it("cancel aborts a running scenario", async () => {
    const updates: SessionNotification[] = [];
    const { client, sessionId } = await connectedClient((n) => updates.push(n));
    configureMockAgent({
      scenario: "longTranscript",
      options: { sections: 1000, delayMs: 5 },
    });
    const turn = client.prompt(sessionId, [{ type: "text", text: "go" }]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await client.cancel(sessionId);
    const response = await turn;
    expect(response.stopReason).toBe("cancelled");
  });

  it("mock MCP endpoint satisfies the seam without advertising a server", async () => {
    const endpoint = createMockMcpEndpoint();
    await endpoint.start();
    expect(endpoint.mcpServer).toBeUndefined();
    const unsubscribe = endpoint.onRequest(() => {});
    unsubscribe();
    await endpoint.close();
  });
});
