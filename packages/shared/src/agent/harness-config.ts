import { z } from "zod";

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
   * - "none": harness gets no app tools.
   */
  mcpRegistration: z.enum(["session-new", "opencode-config", "none"]),
});

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

/**
 * Fill a harness's `resumeCommand` template for one concrete session.
 * Substituted values are shell-quoted — a workspace path containing spaces,
 * quotes, or `$(...)` pastes into a terminal as the literal argument, never
 * as syntax. Returns null when the harness declares no template — callers
 * hide the affordance rather than guessing a CLI invocation.
 */
export function buildHarnessResumeCommand(
  harness: HarnessDefinition,
  params: { sessionId: string; workspacePath: string },
): string | null {
  if (!harness.resumeCommand) return null;
  // split/join = replaceAll (this package's TS lib predates ES2021).
  return harness.resumeCommand
    .split("${sessionId}")
    .join(shellQuoteArg(params.sessionId))
    .split("${workspace}")
    .join(shellQuoteArg(params.workspacePath));
}

/**
 * Harnesses Metrists knows how to spawn out of the box. Each is an existing
 * ACP adapter; a future Metrists-owned harness is just another entry.
 */
export const BUILT_IN_HARNESSES: HarnessDefinition[] = [
  {
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
  {
    id: "opencode",
    label: "OpenCode",
    // --cwd scopes OpenCode's project detection to the workspace (the spike
    // relied on it); session/new's cwd alone is not guaranteed to set it.
    command: "opencode",
    args: ["acp", "--cwd", "${workspace}"],
    env: {},
    authHint: "Run `opencode auth login` in a terminal on this machine.",
    mcpRegistration: "opencode-config",
  },
  {
    id: "gemini-cli",
    label: "Gemini CLI",
    command: "gemini",
    args: ["--experimental-acp"],
    env: {},
    authHint: "Run `gemini` once in a terminal to sign in.",
    // No capability-matrix row for gemini yet — don't assume pass-through.
    mcpRegistration: "none",
  },
];

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
    .enum(["session-new", "opencode-config", "none"])
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
