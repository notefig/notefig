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
import {
  MCP_SERVER_NAME,
  type AvailableCommand,
  type Cost,
  type McpServer,
  type PromptResponse,
  type SessionConfigSelect,
  type SessionNotification,
  type TokenCounts,
  type UsageLimits,
} from "@notefig/shared/agent";

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

/** Anything a harness may tag with vendor `_meta`. */
export type WithMeta = { _meta?: Record<string, unknown> | null };

export type UsageUpdate = Extract<
  SessionNotification["update"],
  { sessionUpdate: "usage_update" }
>;

/** One model's share of a turn, as a harness splits it. */
export type ModelTokens = { model: string; tokens: TokenCounts };

/**
 * How a harness counts a turn (docs/architecture/spikes/
 * acp-token-usage-spike.md). The agent subsystem's normalizer
 * (`turn-usage.ts`) folds these into the shared usage shapes; every vendor
 * `_meta` field it needs is read here, by the harness that sends it.
 */
export interface UsageReader {
  /** Whether `PromptResponse.usage.inputTokens` already includes cache
   *  reads (they are taken out, so input is uncached only). */
  cacheInInput(response: PromptResponse): boolean;
  /** The session-running cost a `usage_update` reports, if any. */
  costTotal(update: UsageUpdate): Cost | null;
  /** The turn's tokens summed from per-request updates, for a harness whose
   *  `PromptResponse.usage` covers its last request only; null = the
   *  response stands. */
  requestTokens(updates: readonly UsageUpdate[]): TokenCounts | null;
  /** The harness's own per-model split of a turn, if it sends one. */
  modelRows(response: PromptResponse): ModelTokens[] | null;
  /** The model a `usage_update` names, if it names one. */
  updateModel(update: UsageUpdate): string | null;
}

/** ACP's own `usage_update.cost`, as money. */
export function acpCostTotal(update: UsageUpdate): Cost | null {
  const cost = update.cost;
  return cost && typeof cost.amount === "number"
    ? { amount: cost.amount, currency: cost.currency, type: "currency" }
    : null;
}

/** A harness that reports through ACP's own fields alone. */
export const ACP_USAGE: UsageReader = {
  cacheInInput: () => false,
  costTotal: acpCostTotal,
  requestTokens: () => null,
  modelRows: () => null,
  updateModel: () => null,
};

/** A non-negative finite count, or 0. */
export function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

/** ACP's raw token counts as normalized ones; with `cacheInInput`, cache
 *  reads are taken out of input. */
export function tokensFrom(
  raw: NonNullable<PromptResponse["usage"]>,
  cacheInInput: boolean,
): TokenCounts {
  const cacheRead = count(raw.cachedReadTokens);
  const input = count(raw.inputTokens);
  return {
    input: cacheInInput ? Math.max(0, input - cacheRead) : input,
    cacheRead,
    cacheWrite: count(raw.cachedWriteTokens),
    output: count(raw.outputTokens),
    thought: count(raw.thoughtTokens),
  };
}

/** A harness's brand mark as SVG data, drawn in `currentColor` so it
 *  follows the surrounding text in both themes. Data rather than a
 *  component, so nothing reading an adapter pulls React. */
export type HarnessMark = {
  viewBox: string;
  fillRule?: "evenodd";
  paths: readonly { d: string; opacity?: number }[];
};

/** What a harness offers, found without a session the user started. */
export interface DiscoveredCatalog {
  /** Its switchable settings, the model among them; null = not found. */
  configOptions: SessionConfigSelect[] | null;
  /** Its commands and skills; null = not found. */
  commands: AvailableCommand[] | null;
  /** `initialize`'s `agentInfo.version`, when it said. */
  harnessVersion?: string;
}

/** What a catalog probe may do — handed in, so an adapter imports no
 *  platform. Each is null when it couldn't run. */
export interface CatalogProbeIo {
  /** Run the harness's own command (not its ACP args) with these args in
   *  the user's login shell. */
  runHarness(args: string[]): Promise<{ stdout: string; exitCode: number } | null>;
  /** Spawn the harness, open a session in a directory that is no
   *  workspace, keep what it reports for a moment, then close it. Nothing
   *  is prompted. */
  probeSession(): Promise<DiscoveredCatalog | null>;
}

export interface HarnessAdapter {
  /** Runs once per task, after the app-tools MCP endpoint is live and
   *  before the harness process spawns. */
  onInvoke(context: HarnessInvokeContext): Promise<HarnessSpawnPrep>;
  /** What it reports beyond tokens, as the token-usage spike found it
   *  (docs/architecture/spikes/acp-token-usage-spike.md). A view uses this
   *  to grey out what a harness will never fill, rather than show an empty
   *  chart as if nothing had been spent. */
  reporting: UsageReporting;
  /** Vendor capabilities it reads from `initialize`'s
   *  `clientCapabilities._meta`. */
  clientMeta?: Record<string, unknown>;
  /** How it counts a turn. */
  usage: UsageReader;
  /** The agent an update or chunk came from, for a harness that streams
   *  its subagents into the parent session: `"root"` for the session's own
   *  agent, a subagent's id, or null when it isn't tagged. */
  agentOf?(update: WithMeta): string | null;
  /** Prefixes it mints the app's MCP tool names under
   *  (`mcp__notefig__author_blob`), stripped so the transcript and
   *  `findBlobAuthorTask` see the plain tool name. */
  toolNamePrefixes: readonly string[];
  /** Whether a failed prompt's error means it needs a sign-in, for a
   *  harness that says so differently from claude-agent-acp
   *  (`needsSignIn`). */
  isAuthError?(message: string): boolean;
  /** Its brand mark; none draws a generic bot. */
  logo?: HarnessMark;
  /** The account limits a `usage_update`'s `_meta` carries, for a harness
   *  that reports them there. */
  limits?(meta: Record<string, unknown>): UsageLimits | null;
  /** Find what it offers before any session the user starts, for the
   *  harness catalog. None (a custom harness): only its sessions tell. */
  discoverCatalog?(io: CatalogProbeIo): Promise<DiscoveredCatalog | null>;
}

/** For a harness whose throwaway session leaves nothing behind: open one
 *  and keep what it reports. */
export const discoverBySession: HarnessAdapter["discoverCatalog"] = (io) =>
  io.probeSession();

/** claude-agent-acp's `mcp__<server>__<tool>` (v2-mcp-passthrough-spike.md). */
export const CLAUDE_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;
/** OpenCode's `<server>_<tool>` (v2-opencode-config-mcp-spike.md). */
export const OPENCODE_TOOL_PREFIX = `${MCP_SERVER_NAME}_`;
/** For a harness whose prefix was never recorded: strip either. */
export const KNOWN_TOOL_PREFIXES = [CLAUDE_TOOL_PREFIX, OPENCODE_TOOL_PREFIX];

/** Whether a failed prompt's error means the harness needs a sign-in: its
 *  own test, else claude-agent-acp's "Authentication required"
 *  (docs/architecture/spikes/phase1-auth-spike.md). */
export function needsSignIn(
  adapter: Pick<HarnessAdapter, "isAuthError">,
  message: string,
): boolean {
  return adapter.isAuthError?.(message) ?? /authentication required/i.test(message);
}

/** Reports nothing beyond tokens. */
export const NO_REPORTING: UsageReporting = { cost: false, limits: false };

export const NO_PREP: HarnessSpawnPrep = {
  env: {},
  passThroughSessionNew: false,
  sessionParams: {},
};
