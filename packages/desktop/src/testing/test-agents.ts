/**
 * The agent layer for tests, built from what a test hands in: a store over
 * its own in-memory database, a runtime over fakes, and the facade over
 * both — no module mocks of the platform, nothing shared between tests.
 */
import type { McpEndpoint } from "@notefig/agent";
import { createHooks, type Hooks } from "@notefig/core";
import { createAgentStore, type AgentStore } from "@/modules/agents/agent-collections";
import {
  createAgentRuntime,
  type AgentRuntime,
  type AgentRuntimeDeps,
} from "@/modules/agents/agent-service";
import { createAgents, type AgentsApi, type AgentsDeps } from "@/modules/agents/agents";
import { createDocuments } from "@/modules/documents";
import { createEditors } from "@/modules/editors";
import { createLayout } from "@/modules/layout";
import { createNodeTestDb } from "./node-db";
import { memoryUrlState } from "./test-core";
import { testKv } from "./test-kv";
import type { KvApi } from "@/modules/kv";
import { createHarnessAdapters } from "@/modules/harness-adapters";

/** A fresh, empty agent store. */
export function testAgentStore(): AgentStore {
  return createAgentStore(createNodeTestDb().get());
}

/** An MCP endpoint that carries no traffic: enough for a task to start. */
export function fakeMcpEndpoint(): McpEndpoint {
  return {
    mcpServer: { name: "notefig", command: "notefig", args: [], env: [] },
    start: async () => {},
    onRequest: () => () => {},
    close: async () => {},
  } as unknown as McpEndpoint;
}

export interface TestAgents {
  deps: AgentRuntimeDeps;
  /** The bus the layer announces on; a test listens here. */
  hooks: Hooks;
  store: AgentStore;
  runtime: AgentRuntime;
  agents: AgentsApi;
}

/**
 * The store, runtime and facade, wired as the agents module wires them.
 * Every dependency defaults to a fake a test can override: the fs answers
 * every write and reads empty files, the MCP endpoint is inert, spawning a
 * real transport throws (tasks start through the transport factory a test
 * passes), and the tools' history and files throw until given.
 */
export function testAgents(
  overrides: Partial<Omit<AgentRuntimeDeps, "kv" | "hooks">> & {
    kv?: KvApi;
    hooks?: Hooks;
  } = {},
  facade: Partial<Omit<AgentsDeps, "runtime" | "store" | "kv">> = {},
): TestAgents {
  const store = overrides.store ?? testAgentStore();
  const kv = overrides.kv ?? testKv();
  const hooks = overrides.hooks ?? createHooks();
  const fs: AgentRuntimeDeps["fs"] = overrides.fs ?? {
    readFiles: async (paths) => ({
      succeeded: paths.map((path) => ({ path, content: "" })),
      failed: [],
    }),
    writeFiles: async (files) => ({
      succeeded: files.map((file) => file.path),
      failed: [],
    }),
  };
  const editors = createEditors();
  const documents = createDocuments({ fs, openFiles: () => [], editors });
  const layout = createLayout(memoryUrlState());
  let agents: AgentsApi | null = null;
  const deps: AgentRuntimeDeps = {
    store,
    kv,
    fs,
    proc: {
      createMcpEndpoint: () => fakeMcpEndpoint(),
      createAgentTransport: () => {
        throw new Error("this test spawns no real agent transport");
      },
    },
    services: () => ({
      get history(): never {
        throw new Error("no history in this test");
      },
      get files(): never {
        throw new Error("no workspace files in this test");
      },
      documents,
      layout,
      editors,
    }),
    agents: () => agents!,
    hooks,
    harnessAdapters: createHarnessAdapters(),
    ...overrides,
  };
  const runtime = createAgentRuntime(deps);
  agents = createAgents({
    runtime,
    store,
    kv,
    openAgentTab: () => {},
    isOpen: () => true,
    ensureRuntime: () => true,
    hooks,
    ...facade,
  });
  return { deps, hooks, store, runtime, agents };
}
