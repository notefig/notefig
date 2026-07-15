import { platformAdapter } from "@/adapters";
import {
  BUILT_IN_HARNESSES,
  parseCustomHarnessEntries,
  parseHarnessOverrides,
  type CustomHarnessEntry,
  type HarnessDiscoveryResult,
  type HarnessOverride,
} from "@metrists/shared/agent";

/**
 * All domain knowledge for harness discovery lives here: the probe script,
 * its sentinel format, and result parsing. `platformAdapter.runShellCommand`
 * is a generic "run this script locally" primitive — it never hears the
 * word "harness".
 */
const HARNESS_KV_NAMESPACE = "harness-settings";
const OVERRIDES_KEY = "overrides";
const CUSTOM_KEY = "custom";
const DISCOVERY_KEY = "discovery";

const SENTINEL_PREFIX = "__MHD";
const SENTINEL_SUFFIX = "__END__";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildProbeScript(commands: string[]): string {
  return commands
    .map(
      (cmd, i) =>
        `printf '${SENTINEL_PREFIX}${i}__%s${SENTINEL_SUFFIX}' "$(command -v ${shellQuote(cmd)} 2>/dev/null)"`,
    )
    .join("; ");
}

function parseProbeOutput(
  commands: string[],
  stdout: string,
): { found: boolean; resolvedPath?: string }[] {
  return commands.map((_cmd, i) => {
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
 * Probe whether each `{id, command}` entry's binary exists on this machine.
 * Batches every command into a single shell invocation (spawning a login
 * shell is the expensive part). Falls back to "nothing found" if the
 * platform can't run local shell scripts at all (the browser adapter today)
 * — that and "the binary genuinely isn't installed" are the same observable
 * outcome from here, so no platform branch is needed beyond this catch.
 */
export async function discoverHarnesses(
  entries: { id: string; command: string }[],
): Promise<Record<string, HarnessDiscoveryResult>> {
  const probedAt = Date.now();
  if (entries.length === 0) return {};

  let probed: { found: boolean; resolvedPath?: string }[];
  try {
    const { stdout } = await platformAdapter.runShellCommand(
      buildProbeScript(entries.map((e) => e.command)),
    );
    probed = parseProbeOutput(
      entries.map((e) => e.command),
      stdout,
    );
  } catch {
    probed = entries.map(() => ({ found: false }));
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

/** Candidate `{id, command}` pairs to probe: built-ins (overridden commands
 *  win) plus enabled custom entries. */
export function candidateProbeEntries(
  overrides: Record<string, HarnessOverride>,
  custom: CustomHarnessEntry[],
): { id: string; command: string }[] {
  const builtins = BUILT_IN_HARNESSES.map((h) => ({
    id: h.id,
    command: overrides[h.id]?.command ?? h.command,
  }));
  const customEntries = custom
    .filter((c) => c.enabled !== false)
    .map((c) => ({ id: c.id, command: c.command }));
  return [...builtins, ...customEntries];
}

/** Run discovery for every known harness and persist the results. Trigger
 *  sites: app startup, settings "Rescan". Read-only w.r.t. `overrides`/
 *  `custom` — discovery only ever writes the `discovery` key. */
export async function refreshHarnessDiscovery(
  overrides: Record<string, HarnessOverride>,
  custom: CustomHarnessEntry[],
): Promise<Record<string, HarnessDiscoveryResult>> {
  const results = await discoverHarnesses(
    candidateProbeEntries(overrides, custom),
  );
  await platformAdapter.setKv(HARNESS_KV_NAMESPACE, DISCOVERY_KEY, results);
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
        platformAdapter.getKv<unknown>(HARNESS_KV_NAMESPACE, OVERRIDES_KEY),
        platformAdapter.getKv<unknown>(HARNESS_KV_NAMESPACE, CUSTOM_KEY),
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
