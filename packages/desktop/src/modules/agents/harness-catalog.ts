/**
 * What a harness offers — its switchable settings (the model among them)
 * and its slash commands and skills — as kept on its row
 * (`HarnessRow.catalog`). ACP only reports these once a session exists,
 * and the composer needs them before one does, so `core.harnesses` keeps
 * the last report. No storage here: the harness handle writes what these
 * compute.
 */
import type {
  AvailableCommand,
  HarnessDefinition,
  SessionConfigSelect,
} from "@notefig/shared/agent";
import type { CoreHookMap } from "@notefig/core";

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
}

/** What a session reported about its harness. */
export type SessionOffer = Pick<
  CoreHookMap["agent:catalog"],
  "harness" | "configOptions"
>;

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
 * are not kept: they may be the workspace's own skills (MET-223). Undefined
 * when the report holds nothing to keep.
 */
export function catalogWithSession(
  current: HarnessCatalog | undefined,
  offer: SessionOffer,
  at: number,
): HarnessCatalog | undefined {
  if (!offer.configOptions) return undefined;
  const fingerprint = definitionFingerprint(offer.harness);
  const kept =
    current?.definitionFingerprint === fingerprint
      ? current
      : { configOptions: null, commands: null };
  return {
    ...kept,
    configOptions: offer.configOptions,
    source: "session",
    fetchedAt: at,
    definitionFingerprint: fingerprint,
  };
}
