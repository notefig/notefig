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

import {
  NotefigAcpClient,
  createLoopbackPair,
  normalizeSessionConfig,
} from "@notefig/agent";
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
    it("sends session/close through the library and carries the sessionId", async () => {
      const { client, agent, agentSide } = makeClient();
      await client.connect();
      const methods: string[] = [];
      agentSide.onLine((line) => {
        try {
          const msg = JSON.parse(line) as { method?: string };
          if (msg.method) methods.push(msg.method);
        } catch {
          // not ours
        }
      });
      await client.closeSession("sess_close_ok");
      expect(agent.closeSessionParams).toEqual({ sessionId: "sess_close_ok" });
      expect(methods).toContain("session/close");
    });

    it("rejects with the agent's error message (an adapter without the method answers -32601)", async () => {
      const { client, agent } = makeClient();
      await client.connect();
      agent.onCloseSession = async () => {
        throw new Error("close not supported here");
      };
      await expect(client.closeSession("sess_err")).rejects.toThrow(
        "close not supported here",
      );
    });

    it("rejects when the transport closes before a response arrives", async () => {
      const { client, agent, clientSide } = makeClient();
      await client.connect();
      agent.onCloseSession = () => new Promise(() => {});
      const pending = client.closeSession("sess_dead");
      await clientSide.close();
      await expect(pending).rejects.toThrow("ACP connection closed");
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

// ─── Session config options (MET-81) ────────────────────────────────────────

const modes = {
  currentModeId: "default",
  availableModes: [
    { id: "default", name: "Default", description: "Ask first" },
    { id: "plan", name: "Plan" },
  ],
};
const models = {
  currentModelId: "sonnet",
  availableModels: [
    { modelId: "sonnet", name: "Sonnet" },
    { modelId: "opus", name: "Opus", description: "Slower, smarter" },
  ],
};
const nativeOptions = [
  {
    id: "permission_mode",
    name: "Permissions",
    category: "mode",
    type: "select",
    currentValue: "ask",
    options: [
      { value: "ask", name: "Ask" },
      { value: "auto", name: "Auto" },
    ],
  },
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "a",
    options: [
      {
        group: "fast",
        name: "Fast",
        options: [{ value: "a", name: "A" }],
      },
      {
        group: "smart",
        name: "Smart",
        options: [{ value: "b", name: "B" }],
      },
    ],
  },
  { id: "verbose", name: "Verbose", type: "boolean", currentValue: false },
];

describe("normalizeSessionConfig", () => {
  it("uses native configOptions verbatim (minus booleans) and ignores modes", () => {
    const { options, sources } = normalizeSessionConfig({
      configOptions: nativeOptions as never,
      modes,
    });
    expect(options.map((o) => o.id)).toEqual(["permission_mode", "model"]);
    expect([...sources.values()]).toEqual(["config", "config"]);
  });

  it("synthesizes a mode option from legacy modes", () => {
    const { options, sources } = normalizeSessionConfig({ modes });
    expect(options).toEqual([
      {
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: "default",
        options: [
          { value: "default", name: "Default", description: "Ask first" },
          { value: "plan", name: "Plan", description: undefined },
        ],
      },
    ]);
    expect(sources.get("mode")).toBe("mode");
  });

  it("synthesizes a model option from the unstable models block, after the mode", () => {
    const { options, sources } = normalizeSessionConfig({ models, modes });
    expect(options.map((o) => [o.id, o.category, o.currentValue])).toEqual([
      ["mode", "mode", "default"],
      ["model", "model", "sonnet"],
    ]);
    expect(options[1].options).toEqual([
      { value: "sonnet", name: "Sonnet", description: undefined },
      { value: "opus", name: "Opus", description: "Slower, smarter" },
    ]);
    expect(sources.get("model")).toBe("model");
  });

  it("is empty when the agent advertises nothing", () => {
    expect(normalizeSessionConfig({}).options).toEqual([]);
    expect(normalizeSessionConfig({ configOptions: [] }).options).toEqual([]);
  });
});

describe("session config options over the wire", () => {
  function makeConfigClient(newSessionResult: Json) {
    const onSessionConfigChange = vi.fn();
    const onSessionUpdate = vi.fn();
    const [clientSide, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    agent.newSessionResult = { sessionId: "sess_cfg", ...newSessionResult };
    const client = new NotefigAcpClient({
      taskId: "task_cfg",
      transport: clientSide,
      permissionBroker: new PermissionBroker("task_cfg"),
      onSessionUpdate,
      onSessionConfigChange,
      fs: { readTextFile, writeTextFile },
    });
    return { client, agent, onSessionConfigChange, onSessionUpdate };
  }

  it("reports the normalized options after session/new and reads them back", async () => {
    const { client, onSessionConfigChange } = makeConfigClient({ modes, models });
    await client.connect();
    await client.newSession("/ws");
    expect(client.sessionConfigOptions("sess_cfg").map((o) => o.id)).toEqual([
      "mode",
      "model",
    ]);
    expect(onSessionConfigChange).toHaveBeenCalledWith(
      "sess_cfg",
      client.sessionConfigOptions("sess_cfg"),
    );
    expect(client.sessionConfigOptions("sess_other")).toEqual([]);
  });

  it("reports options after session/load too", async () => {
    const { client, agent } = makeConfigClient({});
    agent.onLoadSession = async () => ({ configOptions: nativeOptions });
    await client.connect();
    await client.loadSession("sess_loaded", "/ws");
    expect(client.sessionConfigOptions("sess_loaded").map((o) => o.id)).toEqual(
      ["permission_mode", "model"],
    );
  });

  it("switches a native option through session/set_config_option and adopts the answer", async () => {
    const { client, agent } = makeConfigClient({ configOptions: nativeOptions });
    await client.connect();
    await client.newSession("/ws");
    const after = await client.setSessionConfigOption("sess_cfg", "model", "b");
    expect(agent.setParams.get("session/set_config_option")).toEqual({
      sessionId: "sess_cfg",
      configId: "model",
      value: "b",
    });
    expect(after.find((o) => o.id === "model")?.currentValue).toBe("b");
    expect(after.map((o) => o.id)).toEqual(["permission_mode", "model"]);
  });

  it("switches a legacy mode through session/set_mode and applies the value locally", async () => {
    const { client, agent, onSessionConfigChange } = makeConfigClient({ modes });
    // No echo from this agent — the local apply alone must move the value.
    agent.onSetMode = async () => ({});
    await client.connect();
    await client.newSession("/ws");
    onSessionConfigChange.mockClear();
    const after = await client.setSessionConfigOption("sess_cfg", "mode", "plan");
    expect(agent.setParams.get("session/set_mode")).toEqual({
      sessionId: "sess_cfg",
      modeId: "plan",
    });
    expect(after[0].currentValue).toBe("plan");
    expect(onSessionConfigChange).toHaveBeenCalledTimes(1);
  });

  it("switches a legacy model through session/set_model", async () => {
    const { client, agent } = makeConfigClient({ models });
    await client.connect();
    await client.newSession("/ws");
    const after = await client.setSessionConfigOption("sess_cfg", "model", "opus");
    expect(agent.setParams.get("session/set_model")).toEqual({
      sessionId: "sess_cfg",
      modelId: "opus",
    });
    expect(after[0].currentValue).toBe("opus");
  });

  it("rejects a switch the agent refuses and leaves the options unchanged", async () => {
    const { client, agent } = makeConfigClient({ modes });
    agent.onSetMode = async () => {
      throw new Error("mode locked");
    };
    await client.connect();
    await client.newSession("/ws");
    await expect(
      client.setSessionConfigOption("sess_cfg", "mode", "plan"),
    ).rejects.toThrow("mode locked");
    expect(client.sessionConfigOptions("sess_cfg")[0].currentValue).toBe(
      "default",
    );
  });

  it("rejects a switch for an option the session never advertised", async () => {
    const { client } = makeConfigClient({});
    await client.connect();
    await client.newSession("/ws");
    await expect(
      client.setSessionConfigOption("sess_cfg", "model", "opus"),
    ).rejects.toThrow('session has no config option "model"');
  });

  it("folds current_mode_update into the mode option and still forwards it", async () => {
    const { client, agent, onSessionUpdate } = makeConfigClient({ modes });
    await client.connect();
    await client.newSession("/ws");
    agent.update("sess_cfg", {
      sessionUpdate: "current_mode_update",
      currentModeId: "plan",
    });
    await vi.waitFor(() =>
      expect(client.sessionConfigOptions("sess_cfg")[0].currentValue).toBe(
        "plan",
      ),
    );
    expect(onSessionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ sessionUpdate: "current_mode_update" }),
      }),
    );
  });

  it("folds current_mode_update into the native mode-category option, keeping an unlisted value", async () => {
    const { client, agent } = makeConfigClient({ configOptions: nativeOptions });
    await client.connect();
    await client.newSession("/ws");
    agent.update("sess_cfg", {
      sessionUpdate: "current_mode_update",
      currentModeId: "bypass",
    });
    await vi.waitFor(() =>
      expect(
        client.sessionConfigOptions("sess_cfg").find((o) => o.id === "permission_mode")
          ?.currentValue,
      ).toBe("bypass"),
    );
  });

  it("replaces the list on config_option_update", async () => {
    const { client, agent } = makeConfigClient({ modes });
    await client.connect();
    await client.newSession("/ws");
    agent.update("sess_cfg", {
      sessionUpdate: "config_option_update",
      configOptions: nativeOptions,
    });
    await vi.waitFor(() =>
      expect(client.sessionConfigOptions("sess_cfg").map((o) => o.id)).toEqual([
        "permission_mode",
        "model",
      ]),
    );
    // Sources followed the surface: the native model now goes out as a
    // config option, not as the unstable set_model.
    await client.setSessionConfigOption("sess_cfg", "model", "b");
    expect(agent.setParams.has("session/set_config_option")).toBe(true);
    expect(agent.setParams.has("session/set_model")).toBe(false);
  });
});
