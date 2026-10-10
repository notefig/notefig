/**
 * A harness adapter is the code half of a harness: it hooks into the task
 * lifecycle to do whatever that harness demands before it spawns — write a
 * config file, inject env, put the MCP server on the ACP wire. Built-in
 * harnesses each have their own (one file per harness in this folder); a
 * runtime custom harness (settings data only) has no adapter code of its
 * own and resolves to the one its `mcpRegistration` mode names. Either way
 * `core.harnessAdapters.adapterFor` is the one lookup, so the agent service
 * invokes a hook and reads none of its meaning.
 *
 * Hooks get their effects (filesystem, warnings) handed in through the
 * context rather than importing a platform, which keeps the adapters
 * unit-testable with plain fakes.
 */
import type { McpServer } from "@notefig/shared/agent";

/** The stdio variant of ACP's `McpServer` union — the only one that maps
 *  onto a harness config file's local-command shape. HTTP/SSE servers can
 *  only ride the ACP wire. */
export type StdioMcpServer = Extract<McpServer, { command: string }>;

export function isStdioMcpServer(
  server: McpServer | undefined,
): server is StdioMcpServer {
  return server !== undefined && "command" in server;
}

/** What the invoke hook settles for the spawn. */
export interface HarnessSpawnPrep {
  /** Merged over the harness's own env for this spawn. */
  env: Record<string, string>;
  /** Whether the MCP server rides ACP `session/new.mcpServers`. */
  passThroughSessionNew: boolean;
  /** Harness-specific extension fields spread into the ACP `session/new`
   *  and `session/load` requests verbatim. The service applies them
   *  without reading them (devin's `additionalDirectories`). */
  sessionParams: Record<string, unknown>;
}

/** What an invoke hook may know and do. Deliberately thin: the workspace,
 *  path joining in the host's flavor (win32 vs posix), the app dir the host
 *  owns, and the two effects a dialect has needed so far. */
export interface HarnessInvokeContext {
  workspacePath: string;
  joinPath: (...parts: string[]) => string;
  /** The app-owned directory name inside the workspace, supplied by the
   *  host from its own source of truth (desktop's `APP_DIR_NAME`) so this
   *  module holds no second copy of it. */
  appDir: string;
  /** The harness's static env, for dialects that must layer onto a value
   *  the user set themselves (OpenCode's `OPENCODE_CONFIG_CONTENT`). */
  harnessEnv: Record<string, string>;
  /** This task's app-tools endpoint; undefined when the app offers none. */
  mcpServer: McpServer | undefined;
  /** Write files, creating parents; failures come back, never throw. */
  writeFiles: (
    files: { path: string; content: string }[],
  ) => Promise<{ failed: { message: string }[] }>;
  /** Task-scoped console warning. */
  warn: (label: string, detail?: string) => void;
}

/** What a harness reports about usage beyond tokens. */
export type UsageReporting = {
  /** Sends a running cost (`usage_update.cost`). */
  cost: boolean;
  /** Sends account limits the app reads. */
  limits: boolean;
};

export interface HarnessAdapter {
  /** Runs once per task, after the app-tools MCP endpoint is live and
   *  before the harness process spawns. */
  onInvoke(context: HarnessInvokeContext): Promise<HarnessSpawnPrep>;
  /** What it reports beyond tokens, as the token-usage spike found it
   *  (docs/architecture/spikes/acp-token-usage-spike.md). A view uses this
   *  to grey out what a harness will never fill, rather than show an empty
   *  chart as if nothing had been spent. */
  reporting: UsageReporting;
}

/** Reports nothing beyond tokens. */
export const NO_REPORTING: UsageReporting = { cost: false, limits: false };

export const NO_PREP: HarnessSpawnPrep = {
  env: {},
  passThroughSessionNew: false,
  sessionParams: {},
};
