import { describe, it, expect, vi } from "vitest";

import { NotefigAcpClient } from "@notefig/agent";
import type { SessionNotification } from "@notefig/shared/agent";
import { PermissionBroker } from "../permission-broker";
import {
  createMockAgentTransport,
  createMockMcpEndpoint,
  configureMockAgent,
  lastMockSetParams,
  registerMockScenario,
} from "../mock-harness";
import { testAgentStore } from "@/testing/test-agents";

async function connectedClient(onUpdate: (n: SessionNotification) => void) {
  const transport = createMockAgentTransport();
  const client = new NotefigAcpClient({
    taskId: "task_test",
    transport,
    permissionBroker: new PermissionBroker(
      "task_test",
      testAgentStore().permissionRequests,
    ),
    onSessionUpdate: onUpdate,
    fs: {
      readTextFile: vi.fn(async () => ""),
      writeTextFile: vi.fn(async () => {}),
    },
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

describe("mock harness session settings (MET-81)", () => {
  it("seeds configured session fields into session/new and scripts the set_* methods", async () => {
    configureMockAgent({
      scenario: "echo",
      session: {
        modes: {
          currentModeId: "default",
          availableModes: [
            { id: "default", name: "Default" },
            { id: "plan", name: "Plan" },
          ],
        },
      },
    });
    try {
      const updates: SessionNotification[] = [];
      const { client, sessionId } = await connectedClient((n) =>
        updates.push(n),
      );
      expect(client.sessionConfigOptions(sessionId).map((o) => o.id)).toEqual(
        ["mode"],
      );
      const after = await client.setSessionConfigOption(sessionId, "mode", "plan");
      expect(after[0].currentValue).toBe("plan");
      expect(lastMockSetParams("session/set_mode")).toEqual({
        sessionId,
        modeId: "plan",
      });
      // The default set_mode echoes a current_mode_update like claude-code-acp.
      await vi.waitFor(() =>
        expect(
          updates.some((n) => n.update.sessionUpdate === "current_mode_update"),
        ).toBe(true),
      );
    } finally {
      configureMockAgent({ scenario: "echo" });
    }
  });

  it("answers set_config_option from the configured native options", async () => {
    configureMockAgent({
      scenario: "echo",
      session: {
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "a",
            options: [
              { value: "a", name: "A" },
              { value: "b", name: "B" },
            ],
          },
        ],
      },
    });
    try {
      const { client, sessionId } = await connectedClient(() => {});
      const after = await client.setSessionConfigOption(sessionId, "model", "b");
      expect(after).toEqual([
        expect.objectContaining({ id: "model", currentValue: "b" }),
      ]);
      expect(lastMockSetParams("session/set_config_option")).toEqual({
        sessionId,
        configId: "model",
        value: "b",
      });
    } finally {
      configureMockAgent({ scenario: "echo" });
    }
  });
});

describe("the mock's misbehaviours", () => {
  const prompt = (client: NotefigAcpClient, sessionId: string, text: string) =>
    client.prompt(sessionId, [{ type: "text", text }]);

  it("offers them as its commands, right after session/new", async () => {
    configureMockAgent({ scenario: "echo" });
    const updates: SessionNotification[] = [];
    await connectedClient((n) => updates.push(n));
    await vi.waitFor(() =>
      expect(
        updates.find((n) => n.update.sessionUpdate === "available_commands_update"),
      ).toBeDefined(),
    );
    const offered = updates.find(
      (n) => n.update.sessionUpdate === "available_commands_update",
    )!.update as { availableCommands: { name: string }[] };
    expect(offered.availableCommands.map((c) => c.name)).toEqual(
      expect.arrayContaining(["error", "flaky", "crash", "hang", "auth", "evict"]),
    );
  });

  it("fails a turn with an API error, the agent still up", async () => {
    const { client, sessionId } = await connectedClient(() => {});
    await expect(prompt(client, sessionId, "/error")).rejects.toMatchObject({
      message: expect.stringMatching(/Overloaded/),
    });
    await expect(prompt(client, sessionId, "hello")).resolves.toMatchObject({
      stopReason: "end_turn",
    });
  });

  it("asks for a sign-in once, then answers the same prompt", async () => {
    const { client, sessionId } = await connectedClient(() => {});
    await expect(prompt(client, sessionId, "/auth")).rejects.toMatchObject({
      message: "Authentication required",
    });
    await expect(prompt(client, sessionId, "/auth")).resolves.toMatchObject({
      stopReason: "end_turn",
    });
  });

  it("fails a turn on a usage limit, reporting it rejected", async () => {
    const updates: SessionNotification[] = [];
    const { client, sessionId } = await connectedClient((n) => updates.push(n));
    await expect(prompt(client, sessionId, "/rate-limit")).rejects.toMatchObject({
      message: expect.stringMatching(/usage limit/),
    });
    const usage = updates.find((n) => n.update.sessionUpdate === "usage_update");
    expect(JSON.stringify(usage)).toContain('"status":"rejected"');
  });

  it("ends turns as a refusal or on the output limit", async () => {
    const { client, sessionId } = await connectedClient(() => {});
    expect((await prompt(client, sessionId, "/refusal")).stopReason).toBe("refusal");
    expect((await prompt(client, sessionId, "/max-tokens")).stopReason).toBe("max_tokens");
  });

  it("hangs until the turn is cancelled", async () => {
    const { client, sessionId } = await connectedClient(() => {});
    const turn = prompt(client, sessionId, "/hang");
    await new Promise((resolve) => setTimeout(resolve, 50));
    await client.cancel(sessionId);
    expect((await turn).stopReason).toBe("cancelled");
  });

  it("fails the next new session's start", async () => {
    const { client, sessionId } = await connectedClient(() => {});
    await prompt(client, sessionId, "/fail-start");
    await expect(connectedClient(() => {})).rejects.toMatchObject({
      message: expect.stringMatching(/Couldn't start a session/),
    });
    await expect(connectedClient(() => {})).resolves.toBeDefined();
  });

  it("exits its process mid-turn: the transport closes with the reason", async () => {
    const transport = createMockAgentTransport();
    const closed = new Promise((resolve) => transport.onClose(resolve));
    const client = new NotefigAcpClient({
      taskId: "task_test",
      transport,
      permissionBroker: new PermissionBroker("task_test", testAgentStore().permissionRequests),
      onSessionUpdate: () => {},
      fs: { readTextFile: vi.fn(async () => ""), writeTextFile: vi.fn(async () => {}) },
    });
    await transport.start();
    await client.connect();
    const { sessionId } = await client.newSession("/workspace/mock");
    void prompt(client, sessionId, "/crash").catch(() => {});
    expect(await closed).toMatchObject({ message: "agent process exited (code 1)" });
  });
});
