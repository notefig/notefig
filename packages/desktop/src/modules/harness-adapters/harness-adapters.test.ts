import { describe, expect, it } from "vitest";
import {
  BUILT_IN_HARNESSES,
  type HarnessDefinition,
} from "@notefig/shared/agent";
import type { HarnessInvokeContext } from "./adapter";
import { createHarnessAdapters } from "./harness-adapters";

const { adapterFor } = createHarnessAdapters();

/** The host supplies the app dir from its own source of truth; the tests
 *  pick an arbitrary name and assert the adapters thread it through. */
const APP_DIR = ".notefig";

const harness = (id: string): HarnessDefinition =>
  BUILT_IN_HARNESSES.find((entry) => entry.id === id)!;

/** The relay as mcp_bridge.rs mints it: a constant command, a per-task port
 *  in the args and a per-task token in the env. */
const relay = (port = "61234", token = "tok-1") => ({
  name: "notefig",
  command: "/Applications/Notefig.app/notefig",
  args: ["--mcp-stdio-relay", port],
  env: [{ name: "NOTEFIG_MCP_TOKEN", value: token }],
});

/** A context whose filesystem records instead of writing. */
const context = (overrides: Partial<HarnessInvokeContext> = {}) => {
  const written: { path: string; content: string }[] = [];
  const warnings: string[] = [];
  const ctx: HarnessInvokeContext = {
    workspacePath: "/ws",
    joinPath: (...parts) => parts.join("/"),
    appDir: APP_DIR,
    harnessEnv: {},
    mcpServer: relay(),
    writeFiles: async (files) => {
      written.push(...files);
      return { failed: [] };
    },
    warn: (label) => {
      warnings.push(label);
    },
    ...overrides,
  };
  return { ctx, written, warnings };
};

const invoke = (id: string, overrides: Partial<HarnessInvokeContext> = {}) => {
  const { ctx, written, warnings } = context(overrides);
  return adapterFor(harness(id))
    .onInvoke(ctx)
    .then((prep) => ({ prep, written, warnings }));
};

describe("harness adapters", () => {
  it("puts a session-new harness's server on the wire and nowhere else", async () => {
    const { prep, written } = await invoke("claude-code");

    expect(prep.passThroughSessionNew).toBe(true);
    expect(prep.env).toEqual({});
    expect(written).toEqual([]);
  });

  it("gives a none harness nothing at all", async () => {
    const { prep, written } = await invoke("gemini-cli");

    expect(prep).toEqual({
      env: {},
      passThroughSessionNew: false,
      sessionParams: {},
    });
    expect(written).toEqual([]);
  });

  it("gives a custom harness the generic adapter its registration mode names", async () => {
    const custom = (
      mcpRegistration: HarnessDefinition["mcpRegistration"],
    ): HarnessDefinition => ({
      ...harness("gemini-cli"),
      id: "custom:lab",
      command: "lab-acp",
      mcpRegistration,
    });
    const prepFor = (mode: HarnessDefinition["mcpRegistration"]) =>
      adapterFor(custom(mode)).onInvoke(context().ctx);

    expect((await prepFor("session-new")).passThroughSessionNew).toBe(true);
    expect((await prepFor("opencode-config")).env).toHaveProperty(
      "OPENCODE_CONFIG_CONTENT",
    );
    expect((await prepFor("devin-config")).sessionParams).toHaveProperty(
      "additionalDirectories",
    );
    expect(await prepFor("none")).toEqual({
      env: {},
      passThroughSessionNew: false,
      sessionParams: {},
    });
  });

  it("hands OpenCode inline config in the env, touching no disk", async () => {
    const { prep, written } = await invoke("opencode");

    const config = JSON.parse(prep.env.OPENCODE_CONFIG_CONTENT);
    expect(config.mcp.notefig).toEqual({
      type: "local",
      command: [
        "/Applications/Notefig.app/notefig",
        "--mcp-stdio-relay",
        "61234",
      ],
      enabled: true,
      environment: { NOTEFIG_MCP_TOKEN: "tok-1" },
    });
    expect(written).toEqual([]);
    expect(prep.passThroughSessionNew).toBe(false);
  });

  it("deep-merges a harness-env OPENCODE_CONFIG_CONTENT under our entry", async () => {
    const { prep } = await invoke("opencode", {
      harnessEnv: {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          theme: "user-theme",
          mcp: {
            userServer: { type: "remote", url: "https://x.example" },
            // Collides with the entry we inject: nested keys merge, our
            // scalars win, foreign keys survive.
            notefig: { enabled: false, timeout: 99 },
          },
        }),
      },
    });

    const config = JSON.parse(prep.env.OPENCODE_CONFIG_CONTENT);
    expect(config.theme).toBe("user-theme");
    expect(config.mcp.userServer.url).toBe("https://x.example");
    expect(config.mcp.notefig.enabled).toBe(true); // ours wins the collision
    expect(config.mcp.notefig.timeout).toBe(99); // theirs survives the merge
  });

  it("degrades unparseable harness config to an empty base", async () => {
    const { prep } = await invoke("opencode", {
      harnessEnv: { OPENCODE_CONFIG_CONTENT: "{not json" },
    });

    expect(
      JSON.parse(prep.env.OPENCODE_CONFIG_CONTENT).mcp.notefig,
    ).toBeDefined();
  });

  it("writes devin a config in the app dir that names no task-specific value", async () => {
    const { prep, written } = await invoke("devin");

    expect(written).toHaveLength(1);
    expect(written[0].path).toBe(`/ws/${APP_DIR}/.devin/mcp_config.local.json`);
    // Every per-task value is a reference devin expands from the spawn env —
    // that indirection is what lets one file serve every session in the
    // workspace without two tasks clobbering each other's relay.
    expect(JSON.parse(written[0].content).mcpServers.notefig).toEqual({
      command: "/Applications/Notefig.app/notefig",
      args: ["${env:NOTEFIG_MCP_ARG_0}", "${env:NOTEFIG_MCP_ARG_1}"],
      env: { NOTEFIG_MCP_TOKEN: "${env:NOTEFIG_MCP_TOKEN}" },
    });
    expect(prep.env).toEqual({
      NOTEFIG_MCP_ARG_0: "--mcp-stdio-relay",
      NOTEFIG_MCP_ARG_1: "61234",
      NOTEFIG_MCP_TOKEN: "tok-1",
    });
    expect(prep.passThroughSessionNew).toBe(false);
  });

  it("writes the same devin file for every task, whatever its relay", async () => {
    const first = await invoke("devin");
    const second = await invoke("devin", {
      mcpServer: relay("62000", "tok-2"),
    });

    expect(second.written[0].content).toBe(first.written[0].content);
    expect(second.prep.env).not.toEqual(first.prep.env);
  });

  it("degrades a failed devin write to a spawn without app tools", async () => {
    const { prep, warnings } = await invoke("devin", {
      writeFiles: async () => ({ failed: [{ message: "disk full" }] }),
    });

    expect(prep).toEqual({
      env: {},
      passThroughSessionNew: false,
      sessionParams: {},
    });
    expect(warnings).toHaveLength(1);
  });

  it("names the app dir in devin's session so the toolbox sees that file", async () => {
    // The model's tool set is assembled from the SESSION's config scopes —
    // a config the process can merely discover connects but never reaches
    // the toolbox — so the session must claim the app dir explicitly.
    const { prep } = await invoke("devin");

    expect(prep.sessionParams).toEqual({
      additionalDirectories: [`/ws/${APP_DIR}`],
    });
  });

  it("preps nothing when there is no endpoint", async () => {
    for (const id of ["claude-code", "opencode", "devin", "gemini-cli"]) {
      const { prep, written } = await invoke(id, { mcpServer: undefined });
      expect(prep).toEqual({
        env: {},
        passThroughSessionNew: false,
        sessionParams: {},
      });
      expect(written).toEqual([]);
    }
  });

  it("only puts a non-stdio server on the wire — no dialect can write one", async () => {
    const http = {
      name: "notefig",
      type: "http" as const,
      url: "https://x.example",
      headers: [],
    };

    const passthrough = await invoke("claude-code", { mcpServer: http });
    expect(passthrough.prep.passThroughSessionNew).toBe(true);
    expect(passthrough.written).toEqual([]);
    for (const id of ["opencode", "devin"]) {
      const { prep, written } = await invoke(id, { mcpServer: http });
      expect(prep).toEqual({
        env: {},
        passThroughSessionNew: false,
        sessionParams: {},
      });
      expect(written).toEqual([]);
    }
  });
});
