import { z } from "zod";
import type { McpServer } from "@zed-industries/agent-client-protocol";

/** Substituted with the workspace path when a harness spawns (`args`, `cwd`). */
export const WORKSPACE_PLACEHOLDER = "${workspace}";

/**
 * A harness definition describes how to spawn an ACP agent adapter on the
 * user's machine. Definitions come from Metrists built-ins or user settings —
 * never from document content (spawning is gated by per-workspace trust).
 */
export const HarnessDefinitionSchema = z.object({
  /** Stable identifier, e.g. "claude-code" */
  id: z.string().min(1),
  /** Human-readable name shown in settings and the agent panel */
  label: z.string().min(1),
  /** Executable to spawn (resolved against PATH) */
  command: z.string().min(1),
  /** `${workspace}` in an arg is replaced with the workspace path at spawn. */
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
  /**
   * Discovery probe: a shell snippet whose stdout is the evidence the
   * harness is installed (typically a resolved binary path); empty output ⇒
   * not found. Absent = `command -v <command>`. Needed when `command` alone
   * says nothing about availability — e.g. claude-code spawns via `npx`, so
   * probing `npx` would report "found" on any machine with Node.
   */
  probeCommand: z.string().optional(),
  /**
   * Shown when the adapter reports authentication is required, e.g.
   * "Run `claude login` in a terminal on this machine."
   */
  authHint: z.string().optional(),
  /**
   * Terminal command template that reopens an existing session in the
   * harness's own CLI — `${sessionId}` and `${workspace}` are substituted
   * as ALREADY shell-quoted arguments (see `buildHarnessResumeCommand`), so
   * templates must NOT wrap the placeholders in their own quotes. Optional:
   * absent means the harness has no known way to resume by id, and resume
   * affordances are hidden.
   */
  resumeCommand: z.string().optional(),
  /**
   * How this harness learns about the app's MCP tool server — set from the
   * capability matrix (docs/architecture/acp-capability-matrix.md), NOT from
   * the adapter's self-reported `mcpCapabilities` (unreliable: OpenCode
   * advertises http/sse but ignores `session/new.mcpServers`).
   * - "session-new": pass the server through ACP `session/new.mcpServers`
   *   (claude-agent-acp — verified in v2-mcp-passthrough-spike.md).
   * - "opencode-config": write a per-task config file registering the server
   *   and point the spawned process at it via `OPENCODE_CONFIG` (verified in
   *   v2-opencode-config-mcp-spike.md).
   * - "devin-config": write the server into a devin project config under the
   *   app dir and name that dir in the session's `additionalDirectories`,
   *   since devin reads MCP servers only from config files in the session's
   *   scopes and honors no env knob for them (devin-acp-mcp-spike.md).
   * - "none": harness gets no app tools.
   */
  mcpRegistration: z.enum([
    "session-new",
    "opencode-config",
    "devin-config",
    "none",
  ]),
});

/** How a harness is handed the app's MCP server. Each mode names a harness
 *  adapter (below in this module) that realizes it. */
export type McpRegistrationMode = HarnessDefinition["mcpRegistration"];

export type HarnessDefinition = z.infer<typeof HarnessDefinitionSchema>;

/** Safe as a bare (unquoted) POSIX shell word — no quoting needed. */
const SHELL_SAFE_WORD = /^[A-Za-z0-9_.,:/@%^+=-]+$/;

/**
 * Render a value as one literal POSIX shell argument. Single quotes make
 * everything literal ($, backticks, spaces); embedded single quotes close,
 * escape, and reopen ('\''). Values that are plainly safe stay bare so the
 * common command reads clean.
 */
function shellQuoteArg(value: string): string {
  if (SHELL_SAFE_WORD.test(value)) return value;
  return `'${value.split("'").join("'\\''")}'`;
}

/** A placeholder the template author wrapped in their own quotes — e.g.
 *  `"${workspace}"` (the pre-quoting built-in's shape, or a hand-written
 *  custom template). Nesting our single-quoted value inside those quotes
 *  would re-enable `$(...)` inside double quotes and inject literal quote
 *  characters inside single ones, so the wrapper is stripped and our own
 *  quoting becomes the only quoting. */
const QUOTED_PLACEHOLDER = /(["'])(\$\{(?:sessionId|workspace)\})\1/g;

/** Which shell the rendered resume command targets. Templates are authored
 *  in POSIX; "powershell" re-renders the same template for the Windows
 *  default terminal (MET-157). */
export type ResumeShellDialect = "posix" | "powershell";

/** PowerShell literal argument: single quotes, embedded quotes doubled.
 *  Set-Location handles cross-drive `cd` natively (no cmd.exe `/d`). */
function powershellQuoteArg(value: string): string {
  if (SHELL_SAFE_WORD.test(value)) return value;
  return `'${value.split("'").join("''")}'`;
}

/**
 * Fill a harness's `resumeCommand` template for one concrete session.
 * Substituted values are shell-quoted — a workspace path containing spaces,
 * quotes, or `$(...)` pastes into a terminal as the literal argument, never
 * as syntax. Returns null when the harness declares no template — callers
 * hide the affordance rather than guessing a CLI invocation.
 *
 * "powershell" additionally rewrites ` && ` to `; ` — Windows PowerShell
 * 5.1 (the OS default) has no pipeline-chain operators, and `;` preserves
 * the sequencing the templates rely on.
 */
export function buildHarnessResumeCommand(
  harness: HarnessDefinition,
  params: { sessionId: string; workspacePath: string },
  dialect: ResumeShellDialect = "posix",
): string | null {
  if (!harness.resumeCommand) return null;
  const quote = dialect === "powershell" ? powershellQuoteArg : shellQuoteArg;
  let template = harness.resumeCommand.replace(QUOTED_PLACEHOLDER, "$2");
  if (dialect === "powershell") {
    template = template.split(" && ").join("; ");
  }
  // split/join = replaceAll (this package's TS lib predates ES2021).
  return template
    .split("${sessionId}")
    .join(quote(params.sessionId))
    .split("${workspace}")
    .join(quote(params.workspacePath));
}

/**
 * A harness adapter is the code half of a harness: it hooks into the task
 * lifecycle to do whatever that harness demands before it spawns — write a
 * config file, inject env, put the MCP server on the ACP wire. Built-in
 * harnesses are authored WITH their adapter (BUILT_INS below); a runtime
 * custom harness (from kv.json, data only) has no adapter code of its own
 * and resolves to the generic adapter its `mcpRegistration` mode names.
 * Either way `harnessAdapterFor` is the one lookup, so the agent service
 * invokes a hook and reads none of its meaning.
 *
 * Hooks get their effects (filesystem, warnings) handed in through the
 * context rather than importing a platform, which keeps this package
 * host-free and the adapters unit-testable with plain fakes.
 */

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
   *  package holds no second copy of it. */
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

export interface HarnessAdapter {
  /** Runs once per task, after the app-tools MCP endpoint is live and
   *  before the harness process spawns. */
  onInvoke(context: HarnessInvokeContext): Promise<HarnessSpawnPrep>;
}

/** The argv and working directory a harness process spawns with. Lives with
 *  the harness apparatus (spawn shape is harness behavior, not definition
 *  data) so every platform host — the desktop Tauri adapter and the web
 *  tier's agent worker — resolves it one way instead of each re-deriving
 *  the `${workspace}` templating. Every harness spawns in the workspace
 *  itself; anything a dialect needs scoped elsewhere rides its `onInvoke`
 *  plan (env, files, sessionParams), never the process cwd. */
export function resolveHarnessSpawn(
  harness: HarnessDefinition,
  workspacePath: string,
): { args: string[]; cwd: string } {
  return {
    args: harness.args.map((arg) =>
      // split/join = replaceAll (this package's TS lib predates ES2021).
      arg.split(WORKSPACE_PLACEHOLDER).join(workspacePath),
    ),
    cwd: workspacePath,
  };
}

const NO_PREP: HarnessSpawnPrep = {
  env: {},
  passThroughSessionNew: false,
  sessionParams: {},
};

/**
 * "session-new": the adapter takes the server over the wire, in
 * `session/new.mcpServers` (claude-agent-acp — verified in
 * v2-mcp-passthrough-spike.md). Nothing to write, nothing to inject; the
 * only mode that can carry a non-stdio server.
 */
const sessionNewAdapter: HarnessAdapter = {
  onInvoke: async ({ mcpServer }) => ({
    ...NO_PREP,
    passThroughSessionNew: mcpServer !== undefined,
  }),
};

/**
 * "opencode-config": inject the server as `OPENCODE_CONFIG_CONTENT` —
 * inline JSON OpenCode merges last, on top of the user's own global /
 * `OPENCODE_CONFIG` / project configs (merge order verified against
 * opencode 1.18.15, MET-65). A value instead of a file: nothing lands in
 * the workspace, nothing to clean up, and browser transports carry it as
 * plain env (the embedded relay command is already worker-local, so no
 * path rewriting).
 */
const openCodeAdapter: HarnessAdapter = {
  onInvoke: async ({ mcpServer, harnessEnv }) => {
    if (!isStdioMcpServer(mcpServer)) return NO_PREP;
    const config = deepMergeConfigs(
      parseConfigObject(harnessEnv.OPENCODE_CONFIG_CONTENT),
      {
        $schema: "https://opencode.ai/config.json",
        mcp: {
          [mcpServer.name]: {
            type: "local",
            command: [mcpServer.command, ...mcpServer.args],
            enabled: true,
            environment: envRecord(mcpServer),
          },
        },
      },
    );
    return {
      ...NO_PREP,
      env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(config) },
    };
  },
};

/** Args are positional and unnamed, so they're forwarded by index; env
 *  entries keep their own names on both sides of the hop. */
const DEVIN_ARG_VAR_PREFIX = "NOTEFIG_MCP_ARG_";

/** Devin's project config file, under the host-supplied app dir. */
const DEVIN_CONFIG_SEGMENTS = [".devin", "mcp_config.local.json"];

/**
 * "devin-config": devin reads MCP servers only from config files — there is
 * no inline-content env var, `--config` doesn't reach `mcp_config.json`, and
 * `session/new.mcpServers` is not dependable (it connected in one of seven
 * spike runs and never reproduced — devin-acp-mcp-spike.md). The MODEL's
 * tool set is assembled from the SESSION's config scopes (its cwd plus any
 * `additionalDirectories`) — a config merely discoverable from the process
 * cwd connects but never reaches the toolbox (verified 2026-09-11, logged-in
 * devin). So the file lives in the app dir and the session names that dir in
 * `additionalDirectories`, which both connects the server and puts its tools
 * in front of the model; the process spawns in the plain workspace.
 *
 * ONE file serves every devin session in the workspace: the per-task relay
 * port and token are `${env:...}` references devin expands from the spawn
 * env (verified for `command`, `args` and `env` values), so what lands on
 * disk is identical no matter which task wrote it and concurrent tasks
 * can't clobber each other's connection. The file is the app's alone — the
 * user's own `devin` walks up from the workspace and never descends into
 * the app dir — so it is written whole, with nothing of theirs to preserve
 * and nothing of ours to clean up.
 *
 * A file that can't be written is a missing tool set, not a failed task:
 * the harness still spawns, just without the app's tools.
 */
const devinAdapter: HarnessAdapter = {
  onInvoke: async ({
    mcpServer,
    workspacePath,
    joinPath,
    appDir,
    writeFiles,
    warn,
  }) => {
    if (!isStdioMcpServer(mcpServer)) return NO_PREP;
    const document = {
      mcpServers: {
        [mcpServer.name]: {
          command: mcpServer.command,
          args: mcpServer.args.map(
            (_, index) => `\${env:${DEVIN_ARG_VAR_PREFIX}${index}}`,
          ),
          env: Object.fromEntries(
            (mcpServer.env ?? []).map((entry) => [
              entry.name,
              `\${env:${entry.name}}`,
            ]),
          ),
        },
      },
    };
    const written = await writeFiles([
      {
        path: joinPath(workspacePath, appDir, ...DEVIN_CONFIG_SEGMENTS),
        content: JSON.stringify(document, null, 2),
      },
    ]);
    if (written.failed.length > 0) {
      warn(
        "harness MCP config write failed; spawning without app tools",
        written.failed[0].message,
      );
      return NO_PREP;
    }
    const env: Record<string, string> = {};
    mcpServer.args.forEach((value, index) => {
      env[`${DEVIN_ARG_VAR_PREFIX}${index}`] = value;
    });
    for (const entry of mcpServer.env ?? []) env[entry.name] = entry.value;
    return {
      ...NO_PREP,
      env,
      sessionParams: {
        additionalDirectories: [joinPath(workspacePath, appDir)],
      },
    };
  },
};

const noneAdapter: HarnessAdapter = { onInvoke: async () => NO_PREP };

/** The generic adapter each registration mode names — the only capability a
 *  runtime custom harness can reach (by its `mcpRegistrationOverride`). */
const ADAPTER_BY_MODE: Record<McpRegistrationMode, HarnessAdapter> = {
  "session-new": sessionNewAdapter,
  "opencode-config": openCodeAdapter,
  "devin-config": devinAdapter,
  none: noneAdapter,
};

/**
 * The adapter that realizes a harness's MCP registration. A built-in carries
 * its own (BUILT_INS); a custom harness — data with no bespoke code — falls
 * back to the generic adapter its mode names.
 */
export function harnessAdapterFor(harness: HarnessDefinition): HarnessAdapter {
  return (
    BUILT_INS.find((entry) => entry.definition.id === harness.id)?.adapter ??
    ADAPTER_BY_MODE[harness.mcpRegistration]
  );
}

/** The ACP env list as a plain record, the shape config files want. */
function envRecord(server: StdioMcpServer): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const entry of server.env ?? []) environment[entry.name] = entry.value;
  return environment;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A harness env override may carry its own config content; ours layers on
 *  top rather than clobbering it. Unparseable content degrades to `{}` —
 *  the harness itself would reject it too. */
function parseConfigObject(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Layer `overlay` onto `base` with OpenCode's own config-merge semantics
 * (`mergeConfigConcatArrays`): objects merge recursively, arrays concatenate,
 * scalars from the overlay win — so neither side's nested keys (e.g. the
 * `mcp` map) clobber the other's.
 */
function deepMergeConfigs(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const existing = merged[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      merged[key] = deepMergeConfigs(existing, value);
    } else if (Array.isArray(existing) && Array.isArray(value)) {
      merged[key] = [...existing, ...value];
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

/** A built-in harness paired with the adapter that realizes it — the two
 *  halves of one apparatus. `BUILT_IN_HARNESSES` (the definitions alone) is
 *  derived from this for every caller that only needs the data. */
interface BuiltInHarness {
  definition: HarnessDefinition;
  adapter: HarnessAdapter;
}

/**
 * Harnesses Metrists knows how to spawn out of the box, each paired with its
 * adapter. A future Metrists-owned harness is another entry here; the
 * definitions alone are exported as `BUILT_IN_HARNESSES` below.
 */
const BUILT_INS: BuiltInHarness[] = [
  {
    adapter: sessionNewAdapter,
    definition: {
      id: "claude-code",
      label: "Claude Code",
      command: "npx",
      args: ["-y", "@agentclientprotocol/claude-agent-acp"],
      env: {},
      // `command -v npx` would report "found" on any machine with Node; the
      // meaningful availability signal is the Claude Code CLI itself (which
      // the adapter's auth flow needs anyway — see authHint).
      probeCommand: "command -v claude",
      authHint: "Run `claude /login` in a terminal on this machine.",
      // Claude sessions are keyed by cwd, so the resume must run from the
      // workspace (verified in acp-two-way-spike.md — external `--resume`
      // appends to the same session file). No quotes around the placeholders:
      // substitution shell-quotes the values itself.
      resumeCommand: "cd ${workspace} && claude --resume ${sessionId}",
      mcpRegistration: "session-new",
    },
  },
  {
    adapter: openCodeAdapter,
    definition: {
      id: "opencode",
      label: "OpenCode",
      // --cwd scopes OpenCode's project detection to the workspace (the spike
      // relied on it); session/new's cwd alone is not guaranteed to set it.
      command: "opencode",
      args: ["acp", "--cwd", "${workspace}"],
      env: {},
      authHint: "Run `opencode auth login` in a terminal on this machine.",
      // OpenCode scopes sessions to the project directory (the spawn above
      // pins it via --cwd), so the resume runs from the workspace too.
      resumeCommand: "cd ${workspace} && opencode --session ${sessionId}",
      mcpRegistration: "opencode-config",
    },
  },
  {
    adapter: devinAdapter,
    definition: {
      id: "devin",
      label: "Devin",
      // `devin acp` speaks JSON-RPC over stdio and is meant to be spawned by a
      // client, never run interactively. No `--cwd` equivalent exists: the
      // session's cwd (session/new) is what scopes its project detection.
      command: "devin",
      args: ["acp"],
      env: {},
      // `command -v devin` is the whole story here (unlike claude-code's npx):
      // the binary IS the harness. A build too old for the `acp` subcommand
      // can't be told apart by probing — devin parses an unknown subcommand as
      // a path argument and still exits 0 printing help — so that check is
      // left to fail loudly at spawn.
      authHint: "Run `devin auth login` in a terminal on this machine.",
      // Sessions live in devin's own store keyed by cwd (`devin list` is
      // per-directory), so the resume runs from the workspace.
      resumeCommand: "cd ${workspace} && devin --resume ${sessionId}",
      mcpRegistration: "devin-config",
    },
  },
  {
    adapter: noneAdapter,
    definition: {
      id: "gemini-cli",
      label: "Gemini CLI",
      command: "gemini",
      args: ["--experimental-acp"],
      env: {},
      authHint: "Run `gemini` once in a terminal to sign in.",
      // No capability-matrix row for gemini yet — don't assume pass-through.
      mcpRegistration: "none",
    },
  },
];

/** The built-in harness definitions alone — for every caller that needs the
 *  data without the adapter (discovery, settings, effective-harness merge). */
export const BUILT_IN_HARNESSES: HarnessDefinition[] = BUILT_INS.map(
  (entry) => entry.definition,
);

/**
 * Per-machine override of a built-in harness, or the settings row for a
 * fully custom entry (`CustomHarnessEntrySchema` below). Deliberately just
 * command/args/env — model/provider selection (Vertex, Bedrock, a specific
 * model id, ...) is not a distinct schema concept, it's expressed through
 * `env`/`args` like everything else spawn-config already is. A settings UI
 * may offer curated presets that fill in known env vars, but that curation
 * lives in the UI layer, not here.
 */
export const HarnessOverrideSchema = z.object({
  /** Matches a BUILT_IN_HARNESSES id to override, or a custom entry's id. */
  id: z.string().min(1),
  enabled: z.boolean().default(true),
  /** Absent = inherit the built-in's command. */
  command: z.string().optional(),
  /** Absent = inherit; present = replaces the built-in's args, not merged. */
  args: z.array(z.string()).optional(),
  /** Absent = inherit; present = merged over the built-in's env. */
  env: z.record(z.string()).optional(),
  /** Absent = inherit the built-in's probe (or the `command -v` default). */
  probeCommand: z.string().optional(),
  /** Absent = inherit the built-in's resume template (if any). */
  resumeCommand: z.string().optional(),
});

export type HarnessOverride = z.infer<typeof HarnessOverrideSchema>;

/**
 * A material override actually customizes the harness (spawn, probe, or
 * resume template). An enabled-only row is bookkeeping (the on/off switch),
 * NOT a customization — it must not mark the harness "customized" in
 * settings, and it must not exempt it from discovery filtering in pickers.
 */
export function isMaterialOverride(override: HarnessOverride): boolean {
  return (
    override.command !== undefined ||
    override.args !== undefined ||
    override.env !== undefined ||
    override.probeCommand !== undefined ||
    override.resumeCommand !== undefined
  );
}

/**
 * A fully custom harness entry — no built-in counterpart. `mcpRegistration`
 * defaults to "none" (no capability-matrix row exists for an id Metrists has
 * never seen); the explicit opt-in lets a custom entry claim pass-through
 * registration, surfaced with a warning in settings rather than silently.
 */
export const CustomHarnessEntrySchema = HarnessDefinitionSchema.omit({
  mcpRegistration: true,
}).extend({
  mcpRegistrationOverride: z
    .enum(["session-new", "opencode-config", "devin-config", "none"])
    .default("none"),
  enabled: z.boolean().default(true),
});

export type CustomHarnessEntry = z.infer<typeof CustomHarnessEntrySchema>;

/** One probe result per harness id, refreshed by a discovery scan. */
export const HarnessDiscoveryResultSchema = z.object({
  harnessId: z.string(),
  found: z.boolean(),
  /** Absolute path from `command -v`, when found. */
  resolvedPath: z.string().optional(),
  /** Epoch ms. */
  probedAt: z.number(),
});

export type HarnessDiscoveryResult = z.infer<
  typeof HarnessDiscoveryResultSchema
>;

/**
 * Picker visibility: hide built-ins whose binary discovery affirmatively
 * did NOT find (Parsa, 2026-07-15 — an uninstalled harness in the picker is
 * a dead end that fails at spawn). MATERIALLY customized entries — an
 * override that changes command/args/env/probe, and all custom entries —
 * stay visible regardless: the user knows better than the probe. An
 * enabled-only override does NOT exempt (flipping the settings switch is
 * not a claim the binary exists — pointing the command somewhere is). No
 * discovery data for an id (scan never ran, or a new harness) leaves it
 * visible.
 */
export function filterDiscoveredHarnesses(
  effective: HarnessDefinition[],
  overrides: Record<string, HarnessOverride>,
  custom: CustomHarnessEntry[],
  discovery: Record<string, HarnessDiscoveryResult>,
): HarnessDefinition[] {
  const customIds = new Set(custom.map((entry) => entry.id));
  return effective.filter((harness) => {
    const override = overrides[harness.id];
    return (
      (override !== undefined && isMaterialOverride(override)) ||
      customIds.has(harness.id) ||
      discovery[harness.id]?.found !== false
    );
  });
}

/**
 * What the last discovery scan concluded about one harness. Distinct from
 * `filterDiscoveredHarnesses`, which DROPS undiscovered built-ins because a
 * picker must not offer a dead end: a status list has the opposite duty and
 * must keep every row, so "we couldn't check" stays visibly different from
 * "it isn't installed". `unknown` is the honest answer whenever no result
 * exists for the id — the scan never ran (fresh install, first frames), the
 * probe itself failed (browser adapter, Windows, shell timeout — see
 * `discoverHarnesses`'s null return), or the harness is newer than the
 * stored results.
 */
export type HarnessAvailability = "found" | "missing" | "unknown";

/** One harness paired with what discovery found out about it. */
export interface ProbedHarness {
  harness: HarnessDefinition;
  availability: HarnessAvailability;
  /** Absolute path from the probe, when found. */
  resolvedPath?: string;
  /** Epoch ms of the scan that produced this row. */
  probedAt?: number;
}

/**
 * Every effective harness with its probe verdict attached, for surfaces that
 * report readiness rather than offer a choice (the welcome screen's harness
 * list). Order follows `resolveEffectiveHarnesses` — built-ins first, then
 * custom entries.
 *
 * A materially customized entry gets no special treatment here, unlike in
 * `filterDiscoveredHarnesses`: `candidateProbeEntries` probes the OVERRIDE's
 * command, so a `found: false` on a customized row is a real answer about
 * the binary the user actually pointed at, and reporting it as anything else
 * would hide the one thing this list exists to show.
 */
export function describeProbedHarnesses(
  overrides: Record<string, HarnessOverride>,
  custom: CustomHarnessEntry[],
  discovery: Record<string, HarnessDiscoveryResult>,
): ProbedHarness[] {
  return resolveEffectiveHarnesses(overrides, custom).map((harness) => {
    const result = discovery[harness.id];
    if (!result) return { harness, availability: "unknown" as const };
    return {
      harness,
      availability: result.found ? ("found" as const) : ("missing" as const),
      resolvedPath: result.resolvedPath,
      probedAt: result.probedAt,
    };
  });
}

/**
 * Validate a raw `overrides` KV value (kv.json is a plain on-disk file —
 * corrupt or hand-edited rows are dropped, never spawned).
 */
export function parseHarnessOverrides(
  raw: unknown,
): Record<string, HarnessOverride> {
  if (raw === null || typeof raw !== "object") return {};
  const overrides: Record<string, HarnessOverride> = {};
  for (const [id, row] of Object.entries(raw)) {
    const parsed = HarnessOverrideSchema.safeParse(row);
    if (parsed.success) overrides[id] = parsed.data;
  }
  return overrides;
}

/** Validate a raw `discovery` KV value; invalid rows are dropped. */
export function parseHarnessDiscovery(
  raw: unknown,
): Record<string, HarnessDiscoveryResult> {
  if (raw === null || typeof raw !== "object") return {};
  const results: Record<string, HarnessDiscoveryResult> = {};
  for (const [id, row] of Object.entries(raw)) {
    const parsed = HarnessDiscoveryResultSchema.safeParse(row);
    if (parsed.success) results[id] = parsed.data;
  }
  return results;
}

/** Validate a raw `custom` KV value; invalid rows are dropped. */
export function parseCustomHarnessEntries(raw: unknown): CustomHarnessEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((row) => {
    const parsed = CustomHarnessEntrySchema.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
}

/**
 * Resolve the effective, spawnable harness list from built-ins plus
 * per-machine settings: overrides shallow-merge onto their matching
 * built-in (dropping it if disabled), then enabled custom entries are
 * appended. Discovery results are NOT consulted here — an override can
 * point at a binary discovery hasn't (yet) confirmed exists, and the user's
 * explicit configuration wins; "found on this machine" is surfaced
 * separately in the settings UI.
 */
export function resolveEffectiveHarnesses(
  overrides: Record<string, HarnessOverride>,
  custom: CustomHarnessEntry[],
): HarnessDefinition[] {
  const effective: HarnessDefinition[] = [];

  for (const builtin of BUILT_IN_HARNESSES) {
    const override = overrides[builtin.id];
    if (!override) {
      effective.push(builtin);
      continue;
    }
    if (override.enabled === false) {
      continue;
    }
    effective.push({
      ...builtin,
      command: override.command ?? builtin.command,
      args: override.args ?? builtin.args,
      env: override.env ? { ...builtin.env, ...override.env } : builtin.env,
      probeCommand: override.probeCommand ?? builtin.probeCommand,
      resumeCommand: override.resumeCommand ?? builtin.resumeCommand,
    });
  }

  for (const entry of custom) {
    if (entry.enabled === false) continue;
    effective.push({
      ...entry,
      mcpRegistration: entry.mcpRegistrationOverride,
    });
  }

  return effective;
}
