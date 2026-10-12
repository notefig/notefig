/**
 * What a harness offers — its switchable settings (the model among them)
 * and its slash commands and skills — as kept on its row
 * (`HarnessRow.catalog`). ACP only reports these once a session exists,
 * and the composer needs them before one does, so `core.harnesses` keeps
 * the last report: a session's, or a probe's — a throwaway session (or a
 * command) its adapter runs outside any workspace (`discoverCatalog`). No
 * storage here: the harness handle writes what these compute.
 */
import type {
  AvailableCommand,
  HarnessDefinition,
  SessionConfigSelect,
} from "@notefig/shared/agent";
import type { CoreHookMap } from "@notefig/core";
import type { DiscoveredCatalog } from "@/modules/harness-adapters";

/** How long a probe's findings stand before the background check looks
 *  again: what a harness offers changes with its updates, which a session
 *  reporting a new version catches sooner. */
export const CATALOG_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;

/** What one harness offers, as last reported. */
export interface HarnessCatalog {
  /** The full list, the model among them; null = not known. */
  configOptions: SessionConfigSelect[] | null;
  /** Commands and skills in one list; null = not known. */
  commands: AvailableCommand[] | null;
  /** Where it last came from. */
  source: "probe" | "session";
  /** When it last did. */
  fetchedAt: number;
  /** The definition it was reported under (`definitionFingerprint`): a
   *  report under another starts over. */
  definitionFingerprint: string;
  /** When a probe last found it; none = never, or what it found no longer
   *  holds (the harness was updated since). */
  probedAt?: number;
  /** The harness's own version (`initialize`'s `agentInfo.version`) at
   *  that probe: a session reporting another means it was updated since. */
  harnessVersion?: string;
}

/** What a session reported about its harness. */
export type SessionOffer = Pick<
  CoreHookMap["agent:catalog"],
  "harness" | "configOptions" | "harnessVersion"
>;

/** What finds a harness's offer without a session the user started —
 *  its adapter's `discoverCatalog`, given I/O. */
export interface CatalogProbe {
  /** Whether this harness can be probed at all (a custom one can't). */
  has(definition: HarnessDefinition): boolean;
  run(definition: HarnessDefinition): Promise<DiscoveredCatalog | null>;
}

/**
 * A short, stable stand-in for what a harness is spawned with — the
 * command, its args and its env — so a catalog can tell it was reported
 * under another one without storing the env itself twice.
 */
export function definitionFingerprint(
  definition: Pick<HarnessDefinition, "command" | "args" | "env">,
): string {
  const env = Object.entries(definition.env ?? {}).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const text = JSON.stringify([definition.command, definition.args ?? [], env]);
  // FNV-1a, 32-bit: enough to tell edits apart, not a secret.
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * The catalog after a session's report: its settings replace the stored
 * ones. Everything else is kept — unless it was reported under another
 * definition, when it no longer holds and is unknown again. Its commands
 * are not kept: they may be the workspace's own skills (MET-223). A report
 * of another version than the probe saw voids the probe, so the harness is
 * probed again. Undefined when the report changes nothing.
 */
export function catalogWithSession(
  current: HarnessCatalog | undefined,
  offer: SessionOffer,
  at: number,
): HarnessCatalog | undefined {
  const fingerprint = definitionFingerprint(offer.harness);
  const kept = current?.definitionFingerprint === fingerprint ? current : undefined;
  const updated =
    !!kept?.harnessVersion &&
    !!offer.harnessVersion &&
    kept.harnessVersion !== offer.harnessVersion;
  if (!offer.configOptions) {
    return updated ? { ...kept!, probedAt: undefined } : undefined;
  }
  return {
    ...(kept ?? { configOptions: null, commands: null }),
    ...(updated ? { probedAt: undefined } : {}),
    configOptions: offer.configOptions,
    source: "session",
    fetchedAt: at,
    definitionFingerprint: fingerprint,
  };
}

/** Whether a harness should be probed: never yet, or under another
 *  definition, or its findings were voided by an update, or they are older
 *  than `CATALOG_REFRESH_MS`. */
export function needsProbe(
  catalog: HarnessCatalog | undefined,
  definition: HarnessDefinition,
  now: number,
): boolean {
  return (
    catalog?.probedAt === undefined ||
    catalog.definitionFingerprint !== definitionFingerprint(definition) ||
    now - catalog.probedAt >= CATALOG_REFRESH_MS
  );
}

/**
 * The catalog after a probe of the definition `fingerprint` names, begun at
 * `since`, found `found`. Only what it found replaces anything: nothing
 * found is never an empty list. Settings a session of the same definition
 * reported while it ran are newer, and stay. When a session of the same
 * definition reported another version than the probe saw while the probe
 * ran (`versionReportedDuring` — the caller passes no other), the findings
 * are kept but not as fresh: the next check probes the version in use. A
 * version reported before the probe began says nothing about it.
 */
export function catalogWithProbe(
  current: HarnessCatalog | undefined,
  found: DiscoveredCatalog,
  {
    fingerprint,
    since,
    at,
    versionReportedDuring,
  }: {
    fingerprint: string;
    since: number;
    at: number;
    versionReportedDuring?: string;
  },
): HarnessCatalog {
  const kept = current?.definitionFingerprint === fingerprint ? current : undefined;
  const reportedSince =
    kept?.source === "session" && kept.fetchedAt >= since && kept.configOptions !== null;
  const stillCurrent =
    !versionReportedDuring ||
    !found.harnessVersion ||
    versionReportedDuring === found.harnessVersion;
  return {
    configOptions:
      found.configOptions?.length && !reportedSince
        ? found.configOptions
        : (kept?.configOptions ?? null),
    commands: found.commands?.length ? found.commands : (kept?.commands ?? null),
    source: "probe",
    fetchedAt: at,
    definitionFingerprint: fingerprint,
    probedAt: stillCurrent ? at : undefined,
    harnessVersion: found.harnessVersion,
  };
}
