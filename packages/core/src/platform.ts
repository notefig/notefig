/**
 * The platform surfaces the core reaches through, nested inside the service
 * host rather than sitting beside it.
 *
 * The desktop already has an `IPlatformAdapter` with five surfaces — `fs`,
 * `proc`, `db`, `ui`, `updates`. Core needs three of them, and an inventory
 * of actual call sites says how much of each:
 *
 *   proc  3 of 3 — all of it
 *   db    1 of 1 — all of it
 *   fs    7 of 21 (see ./fs.ts)
 *   ui    none — dialogs, fullscreen and external links are portal concerns
 *   upd.  none — restart flows must never be reachable from the core
 *
 * `ui` and `updates` therefore stay in the desktop package. That split is
 * forced regardless of preference: `platform-adapter.interface.ts` imports
 * `Theme` from the theme provider, so the file as it stands cannot be
 * imported by a package that compiles without DOM types.
 *
 * ## Why presence, not a boolean
 *
 * `proc` is optional, and its presence *is* the capability. An earlier draft
 * of the host contract carried a `canSpawnHarnesses` flag, which stated the
 * same fact `ProcessSurface` already encodes — non-desktop adapters reject
 * `createAgentTransport` — in a second place, with a second mechanism
 * (ask-first vs. throw-at-call) that could disagree with it. One source of
 * truth, and the compiler asks the question at every call site.
 *
 * This is the first of the two degradation styles this package uses; see
 * `ServiceHost` for when to reach for the other.
 */
import type { HarnessDefinition } from "@notefig/shared/agent";
import type { AgentTransport, McpEndpoint } from "@notefig/agent";
import type { PersistedCollectionPersistence } from "@tanstack/db-sqlite-persistence-core";
import type { CoreFileSystem } from "./fs";

/**
 * Local process surface. Per MET-119 these keep their agent-specific
 * contracts verbatim — they are regrouped, not generalized — which is also
 * why the desktop adapters satisfy this without modification.
 */
export interface CoreProcess {
  /**
   * Create the agent transport for a new task. Desktop spawns the harness as
   * a local child process (Tauri stdio transport); other platforms plug in
   * their own transport here (e.g. a relay transport) without the agent
   * service ever knowing a transport constructor exists.
   */
  createAgentTransport(spec: {
    taskId: string;
    harness: HarnessDefinition;
    workspacePath: string;
    /**
     * Per-task env on top of the harness's static env — e.g. the
     * OPENCODE_CONFIG path registering this task's MCP server
     * (mcpRegistration: "opencode-config").
     */
    extraEnv?: Record<string, string>;
  }): AgentTransport;

  /**
   * Create the endpoint for a task's app-tools MCP server (Stage 3.5) —
   * same construction contract as `createAgentTransport` right above: a
   * dumb constructor that does nothing async. The caller calls `start()`
   * itself and reads `mcpServer` off the returned instance afterward
   * (populated after start, same pattern as `spawnInfo`) to build ACP
   * `session/new.mcpServers` or a harness config. Deliberately not an
   * AgentTransport: harnesses may run several concurrent instances of the
   * server command, so requests arrive with a per-connection `respond`
   * instead of a single line channel (see McpEndpoint). Desktop's instance
   * spawns its own binary as a stdio↔loopback-TCP relay (`McpServer::Stdio`,
   * mandatory per the ACP spec, unlike `http`/`sse`); other platforms plug
   * in their own mechanism without `mcp-server.ts` or `acp-client.ts` ever
   * seeing a port or process.
   */
  createMcpEndpoint(spec: { taskId: string }): McpEndpoint;

  /**
   * Run a script through the user's local login shell and capture its
   * output. A raw execution primitive — this adapter has no notion of what
   * the script does (harness discovery is the first caller, from
   * src/agent/harness-discovery.ts, which owns all script-building and
   * output-parsing). Desktop-only capability: no equivalent exists on a
   * web/relay platform, so non-desktop adapters reject it, same as
   * `createAgentTransport`'s placeholder above.
   */
  runShellCommand(
    script: string,
  ): Promise<{ stdout: string; exitCode: number }>;
}

/**
 * SQLite-backed storage for persisted TanStack DB collections.
 *
 * Driver-level only: the adapter never names a collection. Ids, schemas and
 * `schemaVersion` belong above it, in the entities layer.
 */
export interface CoreDb {
  /**
   * The shared persistence every persisted collection is built on. Synchronous
   * because collections are defined at module scope, and it touches no storage
   * — the database file, and on web the OPFS entry and its worker, are created
   * by the first collection query.
   */
  get(): PersistedCollectionPersistence;
}

export type CorePlatform = {
  fs: CoreFileSystem;

  /**
   * Absent on a host with no process surface at all. Task creation checks
   * for it and fails with a declared error rather than throwing from deep
   * inside the core.
   */
  proc?: CoreProcess;

  /**
   * Absent on a host with no durable store yet — the headless CLI today.
   * What a core without persistence does (in-memory collections, or refusing
   * to boot) is decided when `agent-persistence` actually moves; declaring
   * the surface optional now records that the question exists rather than
   * answering it early.
   */
  db?: CoreDb;
};
