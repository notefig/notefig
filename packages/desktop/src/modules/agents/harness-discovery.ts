import type { IPlatformAdapter } from "@/adapters/platform-adapter.interface";
import type { HarnessDiscoveryResult } from "@notefig/shared/agent";

/**
 * All domain knowledge for harness discovery lives here: the probe script,
 * its sentinel format, and result parsing. The platform's `proc.runShellCommand`
 * is a generic "run this script locally" primitive — it never hears the
 * word "harness".
 *
 * Each harness's handle (`core.harnesses.harness(id).rescan()`) runs it.
 */

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
export type Proc = Pick<IPlatformAdapter["proc"], "runShellCommand">;

export async function discoverHarnesses(
  proc: Proc,
  entries: ProbeEntry[],
): Promise<Record<string, HarnessDiscoveryResult> | null> {
  const probedAt = Date.now();
  if (entries.length === 0) return {};

  // Windows note (MET-157): the probe script is POSIX and $SHELL is unset
  // there, so runShellCommand fails and this returns null — "couldn't
  // check", which persists nothing and keeps every harness visible. A
  // native PATH×PATHEXT probe was deliberately skipped to avoid growing the
  // adapter surface; install detection on Windows is a future nicety.
  let probed: { found: boolean; resolvedPath?: string }[];
  try {
    const { stdout } = await proc.runShellCommand(buildProbeScript(entries));
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
