import { platformAdapter } from "@/adapters";
import { readKv, writeKv } from "@/utils/kv-store";
import {
  BUILT_IN_HARNESSES,
  parseCustomHarnessEntries,
  parseHarnessOverrides,
  type CustomHarnessEntry,
  type HarnessDiscoveryResult,
  type HarnessOverride,
} from "@notefig/shared/agent";

/**
 * All domain knowledge for harness discovery lives here: the probe script,
 * its sentinel format, and result parsing. `platformAdapter.proc.runShellCommand`
 * is a generic "run this script locally" primitive — it never hears the
 * word "harness".
 *
 * The KV keys are exported as the single source of the storage layout;
 * use-harness-selection.ts (and the future settings UI) import them.
 */
export const HARNESS_SETTINGS_NAMESPACE = "harness-settings";
export const HARNESS_OVERRIDES_KEY = "overrides";
export const HARNESS_CUSTOM_KEY = "custom";
export const HARNESS_DISCOVERY_KEY = "discovery";

const SENTINEL_PREFIX = "__MHD";
const SENTINEL_SUFFIX = "__END__";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** An entry to probe: the definition's own `probeCommand` wins; the default
 *  is `command -v <command>`. */
export type ProbeEntry = { id: string; command: string; probeCommand?: string };

function buildProbeScript(entries: ProbeEntry[]): string {
  return entries
    .map((entry, i) => {
      const probe =
        entry.probeCommand ?? `command -v ${shellQuote(entry.command)}`;
      return `printf '${SENTINEL_PREFIX}${i}__%s${SENTINEL_SUFFIX}' "$(${probe} 2>/dev/null)"`;
    })
    .join("; ");
}

function parseProbeOutput(
  count: number,
  stdout: string,
): { found: boolean; resolvedPath?: string }[] {
  return Array.from({ length: count }, (_, i) => {
    const marker = `${SENTINEL_PREFIX}${i}__`;
    const start = stdout.indexOf(marker);
    if (start === -1) return { found: false };
    const rest = stdout.slice(start + marker.length);
    const end = rest.indexOf(SENTINEL_SUFFIX);
    if (end === -1) return { found: false };
    const resolvedPath = rest.slice(0, end);
    return resolvedPath.length > 0
      ? { found: true, resolvedPath }
      : { found: false };
  });
}

/**
 * Probe whether each entry's harness is present on this machine — via its
 * `probeCommand` when the definition declares one, else `command -v` on its
 * spawn command. Batches every probe into a single shell invocation
 * (spawning a login shell is the expensive part). Returns null when the
 * probe itself couldn't run (browser adapter, shell timeout, spawn error):
 * "we couldn't check" must not be persisted as an affirmative "not
 * installed" — that would hide every built-in from the pickers over a
 * transient failure. Callers skip persistence on null, leaving entries in
 * the no-data (visible) state.
 */
export async function discoverHarnesses(
  entries: ProbeEntry[],
): Promise<Record<string, HarnessDiscoveryResult> | null> {
  const probedAt = Date.now();
  if (entries.length === 0) return {};

  let probed: { found: boolean; resolvedPath?: string }[];
  try {
    const { stdout } = await platformAdapter.proc.runShellCommand(
      buildProbeScript(entries),
    );
    probed = parseProbeOutput(entries.length, stdout);
  } catch {
    return null;
  }

  const results: Record<string, HarnessDiscoveryResult> = {};
  entries.forEach((entry, i) => {
    results[entry.id] = {
      harnessId: entry.id,
      probedAt,
      ...probed[i],
    };
  });
  return results;
}

/** Candidate probe entries: built-ins (overridden command/probe win) plus
 *  enabled custom entries. */
export function candidateProbeEntries(
  overrides: Record<string, HarnessOverride>,
  custom: CustomHarnessEntry[],
): ProbeEntry[] {
  const builtins = BUILT_IN_HARNESSES.map((h) => ({
    id: h.id,
    command: overrides[h.id]?.command ?? h.command,
    // Same inherit rule as resolveEffectiveHarnesses.
    probeCommand: overrides[h.id]?.probeCommand ?? h.probeCommand,
  }));
  const customEntries = custom
    .filter((c) => c.enabled !== false)
    .map((c) => ({
      id: c.id,
      command: c.command,
      probeCommand: c.probeCommand,
    }));
  return [...builtins, ...customEntries];
}

/** Run discovery for every known harness and persist the results. Trigger
 *  sites: app startup, settings "Rescan". Read-only w.r.t. `overrides`/
 *  `custom` — discovery only ever writes the `discovery` key. `writeKv` goes
 *  through the KV collection, so useKv subscribers — the pickers — update
 *  live rather than on next launch (same rationale as the auth mark in
 *  agent-service.ts). A failed probe (null) persists nothing: existing
 *  results stay as they were. */
export async function refreshHarnessDiscovery(
  overrides: Record<string, HarnessOverride>,
  custom: CustomHarnessEntry[],
): Promise<Record<string, HarnessDiscoveryResult> | null> {
  const results = await discoverHarnesses(
    candidateProbeEntries(overrides, custom),
  );
  if (results === null) return null;
  await writeKv(HARNESS_SETTINGS_NAMESPACE, HARNESS_DISCOVERY_KEY, results);
  return results;
}

let startupScanStarted = false;

/** Fire-and-forget startup trigger: run one discovery scan per app session,
 *  reading the current settings straight from KV (this runs outside React).
 *  Failures are logged, never thrown — a failed probe must not affect app
 *  startup, and the stale/absent `discovery` KV simply persists until the
 *  next successful scan. */
export function ensureStartupHarnessDiscovery(): void {
  if (startupScanStarted) return;
  startupScanStarted = true;
  void (async () => {
    try {
      const [rawOverrides, rawCustom] = await Promise.all([
        readKv<unknown>(HARNESS_SETTINGS_NAMESPACE, HARNESS_OVERRIDES_KEY),
        readKv<unknown>(HARNESS_SETTINGS_NAMESPACE, HARNESS_CUSTOM_KEY),
      ]);
      await refreshHarnessDiscovery(
        parseHarnessOverrides(rawOverrides),
        parseCustomHarnessEntries(rawCustom),
      );
    } catch (error) {
      console.warn("Startup harness discovery failed:", error);
    }
  })();
}

/** Test-only: allow the once-per-session guard to re-arm. */
export function resetStartupHarnessDiscoveryForTest(): void {
  startupScanStarted = false;
}
