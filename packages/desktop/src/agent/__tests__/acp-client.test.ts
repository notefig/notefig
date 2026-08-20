import { describe, it, expect, vi } from "vitest";

// acp-client pulls in file-sync → platform adapter, and permission-broker
// reaches the agent collections (which need a db surface at module eval).
vi.mock("@/adapters", async () => ({
  platformAdapter: {
    db: (await import("@/testing/node-db")).createNodeTestDb(),
  },
}));

// The workspace fs surface is an injected dep of the client now.
const readTextFile = vi.fn(async () => "content");
const writeTextFile = vi.fn(async () => {});
const onUnsupportedProtocolVersion = vi.fn();

import { NotefigAcpClient, createLoopbackPair } from "@notefig/agent";
import { PermissionBroker } from "../permission-broker";
import { FakeAgent } from "../mock-harness";
import type { SessionNotification } from "@notefig/shared/agent";

type Json = Record<string, unknown>;

function makeClient(initializeResult?: Json) {
  const [clientSide, agentSide] = createLoopbackPair();
  const agent = new FakeAgent(agentSide);
  if (initializeResult) agent.initializeResult = initializeResult;
  const client = new NotefigAcpClient({
    taskId: "task_acp_test",
    transport: clientSide,
    permissionBroker: new PermissionBroker("task_acp_test"),
    onSessionUpdate: (_n: SessionNotification) => {},
    fs: { readTextFile, writeTextFile },
    onUnsupportedProtocolVersion,
  });
  return { client, agent, clientSide, agentSide };
}

describe("NotefigAcpClient", () => {
  it("rejects protocol calls before connect() establishes the connection", async () => {
    const { client } = makeClient();
    await expect(client.prompt("sess", [])).rejects.toThrow(
      "ACP connection not established",
    );
  });

  it("defaults authMethods to empty and reads embeddedContext capability from initialize", async () => {
    const { client } = makeClient({
      protocolVersion: 1,
      // no authMethods field at all — client must coalesce to []
      agentCapabilities: { promptCapabilities: { embeddedContext: true } },
    });
    await client.connect();
    expect(client.availableAuthMethods).toEqual([]);
    expect(client.authHint).toBeUndefined();
    expect(client.embeddedContextCapability).toBe(true);
  });

  it("surfaces the first auth method's description as the auth hint; capability defaults false", async () => {
    const { client } = makeClient({
      protocolVersion: 1,
      authMethods: [
        { id: "claude-login", name: "login", description: "Run claude /login" },
      ],
    });
    await client.connect();
    expect(client.authHint).toBe("Run claude /login");
    expect(client.embeddedContextCapability).toBe(false);
  });

  it("rejects connect() when the agent negotiates an unsupported protocol version", async () => {
    onUnsupportedProtocolVersion.mockClear();
    const { client } = makeClient({ protocolVersion: 99 });
    // Surfaces through agent-service's startup-failure path rather than
    // proceeding on a connection whose frames we might misread.
    await expect(client.connect()).rejects.toThrow(
      "agent negotiated unsupported ACP protocol version 99 (supported: 1)",
    );
    // The observability hook (telemetry in desktop) hears about it too.
    expect(onUnsupportedProtocolVersion).toHaveBeenCalledWith(99);
  });

  describe("closeSession", () => {
    it("resolves when the agent acknowledges and carries the sessionId", async () => {
      const { client, agent } = makeClient();
      await client.connect();
      await client.closeSession("sess_close_ok");
      expect(agent.closeSessionParams).toEqual({ sessionId: "sess_close_ok" });
    });

    it("ignores non-JSON and unrelated lines while waiting for its response", async () => {
      const { client, agent, agentSide } = makeClient();
      await client.connect();
      // Hang the scripted handler so we control the wire by hand.
      agent.onCloseSession = () => new Promise(() => {});
      let requestId: string | undefined;
      agentSide.onLine((line) => {
        try {
          const msg = JSON.parse(line) as { id?: string; method?: string };
          if (msg.method === "session/close") requestId = msg.id;
        } catch {
          // not ours
        }
      });
      const pending = client.closeSession("sess_noise");
      expect(requestId).toBeDefined();
      // Noise the waiter must skip: a non-JSON frame (the ACP library also
      // sees and tolerates it) and a response addressed to someone else.
      agentSide.send("garbage, not json");
      agentSide.send(
        JSON.stringify({ jsonrpc: "2.0", id: "other", result: {} }),
      );
      agentSide.send(
        JSON.stringify({ jsonrpc: "2.0", id: requestId, result: {} }),
      );
      await expect(pending).resolves.toBeUndefined();
    });

    it("rejects with the agent's error message", async () => {
      const { client, agent } = makeClient();
      await client.connect();
      agent.onCloseSession = async () => {
        throw new Error("close not supported here");
      };
      await expect(client.closeSession("sess_err")).rejects.toThrow(
        "close not supported here",
      );
    });

    it("falls back to a generic message when the error carries no string", async () => {
      const { client, agent, agentSide } = makeClient();
      await client.connect();
      agent.onCloseSession = () => new Promise(() => {});
      let requestId: string | undefined;
      agentSide.onLine((line) => {
        try {
          const msg = JSON.parse(line) as { id?: string; method?: string };
          if (msg.method === "session/close") requestId = msg.id;
        } catch {
          // not ours
        }
      });
      const pending = client.closeSession("sess_weird_err");
      agentSide.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: requestId,
          error: { code: -32000, message: 42 },
        }),
      );
      await expect(pending).rejects.toThrow("session/close failed");
    });

    it("rejects when the transport closes before a response arrives", async () => {
      const { client, agent, clientSide } = makeClient();
      await client.connect();
      agent.onCloseSession = () => new Promise(() => {});
      const pending = client.closeSession("sess_dead");
      await clientSide.close();
      await expect(pending).rejects.toThrow("transport closed");
    });
  });

  describe("client-side fs methods", () => {
    it("readTextFile coalesces null line/limit to undefined for the workspace reader", async () => {
      const { client } = makeClient();
      const response = await client.readTextFile({
        sessionId: "sess",
        path: "/ws/doc.md",
        line: null,
        limit: null,
      });
      expect(response).toEqual({ content: "content" });
      expect(readTextFile).toHaveBeenCalledWith("/ws/doc.md", {
        line: undefined,
        limit: undefined,
      });
    });

    it("writeTextFile delegates to the workspace writer", async () => {
      const { client } = makeClient();
      const response = await client.writeTextFile({
        sessionId: "sess",
        path: "/ws/doc.md",
        content: "# updated",
      });
      expect(response).toEqual({});
      expect(writeTextFile).toHaveBeenCalledWith("/ws/doc.md", "# updated");
    });
  });
});
