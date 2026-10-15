/**
 * Harnesses as the rest of the app sees them — `core.harnesses`. Anything
 * that names a harness outside a session (a usage chart, a session list)
 * needs the same few answers, and this is where the agent subsystem gives
 * them, so no view carries a table of harness quirks of its own:
 *
 * - `collection`: what this machine records about each harness (its edit
 *   or custom entry, its last install check, what it offers — its
 *   catalog: settings and commands), persisted. The hooks in
 *   `react.ts` are live queries over it, and every view is computed from
 *   its rows (`harness-settings.ts`);
 * - the configured definitions and a label for any id, including one
 *   whose custom entry was deleted (its sessions keep the raw id);
 * - each harness's own handle (`harness(id)`), which does what is done to
 *   one harness — its definition, its settings edits, checking it is
 *   installed, keeping what its sessions report it offers. What is done
 *   to all of them (`rescan()`, `track()`) is each handle's, in turn.
 *
 * What a harness does differently at run time is its adapter's
 * (`core.harnessAdapters`).
 */
import { createCollection } from "@tanstack/react-db";
import {
  persistedCollectionOptions,
  type PersistedCollectionPersistence,
} from "@tanstack/db-sqlite-persistence-core";
import {
  BUILT_IN_HARNESSES,
  CustomHarnessEntrySchema,
  HarnessOverrideSchema,
  parseCustomHarnessEntries,
  parseHarnessDiscovery,
  parseHarnessOverrides,
  type CustomHarnessEntry,
  type HarnessDefinition,
  type HarnessDiscoveryResult,
  type HarnessOverride,
} from "@notefig/shared/agent";
import { defineModule, type Hooks } from "@notefig/core";
import { platformModule } from "@/core/services";
import { kvModule, type KvApi } from "@/modules/kv";
import { catalogWithSession, type SessionOffer } from "./harness-catalog";
import {
  discoverHarnesses,
  type ProbeEntry,
  type Proc,
} from "./harness-discovery";
import {
  configuredHarnesses,
  harnessDefinition,
  harnessLabel,
  toggleOverrideEnabled,
  type HarnessRow,
} from "./harness-settings";

/** The collection id, and so the SQLite table the rows land in. */
export const HARNESSES_COLLECTION_ID = "harnesses";

function createHarnessesCollection(persistence: PersistedCollectionPersistence) {
  return createCollection(
    persistedCollectionOptions<HarnessRow, string>({
      id: HARNESSES_COLLECTION_ID,
      getKey: (row) => row.id,
      persistence,
    }),
  );
}

export type HarnessesCollection = ReturnType<typeof createHarnessesCollection>;

/** One harness — `core.harnesses.harness(id)`. */
export interface Harness {
  readonly id: string;
  /** Its definition as configured, on or off: a built-in with this
   *  machine's edit applied, or a custom entry. The stock built-in while
   *  the rows load; undefined for an id that names nothing (a deleted
   *  entry). */
  definition(): HarnessDefinition | undefined;
  /** Replace a built-in's edit on this machine; null goes back to stock.
   *  The install is checked again, since the command may have changed.
   *  False, with nothing written, for an override the schema rejects or an
   *  id that is no built-in. */
  saveOverride(override: HarnessOverride | null): Promise<boolean>;
  /** Add or replace the custom entry with this handle's id (the entry's own
   *  `id` is ignored), then check its install. False, with nothing
   *  written, for an entry the schema rejects or a built-in's id. */
  saveCustom(entry: CustomHarnessEntry): Promise<boolean>;
  /** Offer it in the pickers or not. A built-in switched back to its
   *  natural state (on when found or never checked, off when not found)
   *  keeps no override, unless something else in it is overridden. */
  setEnabled(enabled: boolean): Promise<void>;
  /** Delete a custom entry. A built-in can only be switched off. */
  remove(): Promise<void>;
  /** Check whether its binary is on this machine — its definition's
   *  `probeCommand`, else `command -v` on its spawn command — and record
   *  the verdict. Null when the check couldn't run (no shell on this
   *  platform, a timeout) or the id names no harness: that records
   *  nothing, since "couldn't check" must never read as "not installed". */
  rescan(): Promise<HarnessDiscoveryResult | null>;
  /** Keep what one of its sessions reported it offers on its row
   *  (`catalogWithSession`). Nothing for an id that names no harness (a
   *  session of a custom entry deleted since). */
  recordOffer(offer: SessionOffer): Promise<void>;
}

export interface HarnessesApi {
  /** What this machine records about each harness, persisted; the source
   *  of every view (`harness-settings.ts`). */
  readonly collection: HarnessesCollection;
  /** Resolves once the rows have loaded and settings kept by an older
   *  version have moved into them. Every write waits for it. Idempotent. */
  ready(): Promise<void>;
  /** Whether `ready()` has resolved — until then, a definition read from
   *  the rows may be the stock built-in, or missing for a custom entry. */
  isReady(): boolean;
  /** Built-ins with this machine's edits and custom entries applied —
   *  every enabled harness, whether or not its binary was found. Built-ins
   *  alone until the rows have loaded. */
  configured(): HarnessDefinition[];
  /** A harness's display name: as configured, else the raw id. */
  label(harnessId: string): string;
  /** The harness with this id; the handle reads its row when used, so it
   *  holds for an entry added or edited after it was taken. */
  harness(harnessId: string): Harness;
  /** Rescan every built-in and every enabled custom entry (each handle's
   *  `rescan`). Null when the check couldn't run. */
  rescan(): Promise<Record<string, HarnessDiscoveryResult> | null>;
  /** Boot: keep what sessions report each harness offers
   *  (`"agent:catalog"`, each handle's `recordOffer`). Returns the
   *  unsubscribe. */
  track(): () => void;
}

/**
 * Where harness settings lived before they were rows: one KV namespace
 * holding every override, every custom entry and every install verdict.
 * Read once, by the migration, and then deleted.
 */
const LEGACY_NAMESPACE = "harness-settings";
const LEGACY_KEYS = {
  overrides: "overrides",
  custom: "custom",
  discovery: "discovery",
} as const;

export function createHarnesses({
  persistence,
  kv,
  proc,
  hooks,
  now = Date.now,
}: {
  persistence: PersistedCollectionPersistence;
  /** Read once, for settings kept by an older version. */
  kv: Pick<KvApi, "read" | "remove">;
  proc: Proc;
  /** Where sessions announce what their harness offers. */
  hooks: Pick<Hooks, "on">;
  now?: () => number;
}): HarnessesApi {
  const rows = createHarnessesCollection(persistence);
  const isBuiltIn = (harnessId: string) =>
    BUILT_IN_HARNESSES.some((harness) => harness.id === harnessId);

  /**
   * Write a harness's row, creating it if it has none. A write issued
   * before the rows have loaded would be dropped as already applied (see
   * `workspaces.ts`), so every write waits for `ready()`; after that the
   * read and the write happen in one tick, so two edits at once both land.
   */
  const upsert = (
    harnessId: string,
    change: (row: HarnessRow) => void,
  ): Promise<unknown> => {
    if (rows.has(harnessId)) {
      return rows.update(harnessId, change).isPersisted.promise;
    }
    const row: HarnessRow = { id: harnessId, createdAt: Date.now() };
    change(row);
    return rows.insert(row).isPersisted.promise;
  };

  /** Move the settings an older version kept in KV into rows, then delete
   *  them. Rows already written win nothing over them: the KV is only ever
   *  there before the first launch with rows. */
  const migrate = async () => {
    const [rawOverrides, rawCustom, rawDiscovery] = await Promise.all([
      kv.read<unknown>(LEGACY_NAMESPACE, LEGACY_KEYS.overrides),
      kv.read<unknown>(LEGACY_NAMESPACE, LEGACY_KEYS.custom),
      kv.read<unknown>(LEGACY_NAMESPACE, LEGACY_KEYS.discovery),
    ]);
    if (
      rawOverrides === undefined &&
      rawCustom === undefined &&
      rawDiscovery === undefined
    ) {
      return;
    }
    const writes: Promise<unknown>[] = [];
    const now = Date.now();
    for (const [id, override] of Object.entries(
      parseHarnessOverrides(rawOverrides),
    )) {
      if (!isBuiltIn(id)) continue;
      writes.push(upsert(id, (row) => void (row.override = override)));
    }
    // Their order in the list is their order in the rows.
    parseCustomHarnessEntries(rawCustom).forEach((entry, index) => {
      if (isBuiltIn(entry.id)) return;
      writes.push(
        upsert(entry.id, (row) => {
          row.custom = entry;
          row.createdAt = now + index;
        }),
      );
    });
    const custom = new Set(
      parseCustomHarnessEntries(rawCustom).map((entry) => entry.id),
    );
    for (const [id, install] of Object.entries(
      parseHarnessDiscovery(rawDiscovery),
    )) {
      // A verdict for a custom entry deleted since is not carried over.
      if (!isBuiltIn(id) && !custom.has(id)) continue;
      writes.push(upsert(id, (row) => void (row.install = install)));
    }
    await Promise.all(writes);
    await Promise.all(
      Object.values(LEGACY_KEYS).map((key) => kv.remove(LEGACY_NAMESPACE, key)),
    );
  };

  let readied: Promise<void> | null = null;
  let settled = false;
  const ready = () =>
    (readied ??= rows
      .preload()
      .then(migrate)
      .then(() => void (settled = true)));

  const scans = createScanBatcher({
    proc,
    record: async (results) => {
      await ready();
      await Promise.all(
        Object.values(results).map((install) =>
          upsert(install.harnessId, (row) => void (row.install = install)),
        ),
      );
    },
  });

  const harness = (harnessId: string): Harness => {
    const handle: Harness = {
      id: harnessId,
      definition: () =>
        harnessDefinition(rows.values(), harnessId) ??
        BUILT_IN_HARNESSES.find((harness) => harness.id === harnessId),
      async saveOverride(override) {
        if (!isBuiltIn(harnessId)) return false;
        const checked =
          override === null ? null : HarnessOverrideSchema.safeParse(override);
        if (checked && !checked.success) return false;
        await ready();
        if (checked || rows.has(harnessId)) {
          await upsert(harnessId, (row) => {
            row.override = checked ? { ...checked.data, id: harnessId } : undefined;
          });
        }
        void handle.rescan();
        return true;
      },
      async saveCustom(entry) {
        if (isBuiltIn(harnessId)) return false;
        const checked = CustomHarnessEntrySchema.safeParse({
          ...entry,
          id: harnessId,
        });
        if (!checked.success) return false;
        await ready();
        await upsert(harnessId, (row) => void (row.custom = checked.data));
        void handle.rescan();
        return true;
      },
      async setEnabled(enabled) {
        await ready();
        const row = rows.get(harnessId);
        if (row?.custom) {
          await upsert(harnessId, (draft) => {
            draft.custom = { ...row.custom!, enabled };
          });
          return;
        }
        if (!isBuiltIn(harnessId)) return;
        const next = toggleOverrideEnabled(
          row?.override ? { [harnessId]: row.override } : {},
          harnessId,
          enabled,
          row?.install?.found !== false,
        )[harnessId];
        if (next || row) {
          await upsert(harnessId, (draft) => void (draft.override = next));
        }
      },
      async remove() {
        await ready();
        if (!rows.get(harnessId)?.custom) return;
        await rows.delete(harnessId).isPersisted.promise;
      },
      async rescan() {
        await ready();
        // A disabled entry too, when it is asked for by name.
        const definition = handle.definition();
        if (!definition) return null;
        const { command, probeCommand } = definition;
        return scans.scan({ id: harnessId, command, probeCommand });
      },
      async recordOffer(offer) {
        await ready();
        if (!handle.definition()) return;
        const catalog = catalogWithSession(
          rows.get(harnessId)?.catalog,
          offer,
          now(),
        );
        if (catalog) await upsert(harnessId, (row) => void (row.catalog = catalog));
      },
    };
    return handle;
  };

  return {
    collection: rows,
    ready,
    isReady: () => settled,
    configured: () => configuredHarnesses(rows.values()),
    label: (harnessId) => harnessLabel(rows.values(), harnessId),
    harness,
    async rescan() {
      await ready();
      const custom = [...rows.values()]
        .filter((row) => row.custom && row.custom.enabled !== false)
        .sort((a, b) => a.createdAt - b.createdAt);
      const ids = [
        ...BUILT_IN_HARNESSES.map((builtIn) => builtIn.id),
        ...custom.map((row) => row.id),
      ];
      const verdicts = await Promise.all(ids.map((id) => harness(id).rescan()));
      if (verdicts.some((verdict) => verdict === null)) return null;
      return Object.fromEntries(
        verdicts.map((verdict) => [verdict!.harnessId, verdict!]),
      );
    },
    track: () =>
      hooks.on("agent:catalog", (detail) => {
        harness(detail.harnessId)
          .recordOffer(detail)
          .catch((error) => console.error("Failed to record a harness's catalog:", error));
      }),
  };
}

/**
 * Spawning a login shell is the expensive part of an install check, so
 * the checks asked for in one tick — `rescan()` asking every handle — run
 * as one script, and their verdicts are recorded together. Records go one
 * after another; a batch whose record fails resolves null, and the next
 * batch still runs.
 */
function createScanBatcher({
  proc,
  record,
}: {
  proc: Proc;
  record: (results: Record<string, HarnessDiscoveryResult>) => Promise<void>;
}) {
  let pending: {
    entry: ProbeEntry;
    resolve: (verdict: HarnessDiscoveryResult | null) => void;
  }[] = [];
  let writes: Promise<void> = Promise.resolve();

  const flush = async () => {
    const batch = pending;
    pending = [];
    const results = await discoverHarnesses(
      proc,
      batch.map((item) => item.entry),
    );
    // A verdict that wasn't saved is reported as "couldn't check": the
    // caller (Settings' Rescan) says so, and the next launch checks again.
    let saved = false;
    if (results !== null) {
      const write = writes.then(() => record(results));
      writes = write.catch(() => {});
      saved = await write.then(
        () => true,
        (error) => {
          console.warn("Recording harness install checks failed:", error);
          return false;
        },
      );
    }
    for (const item of batch) {
      item.resolve(saved ? (results?.[item.entry.id] ?? null) : null);
    }
  };

  return {
    scan(entry: ProbeEntry): Promise<HarnessDiscoveryResult | null> {
      return new Promise((resolve) => {
        if (pending.length === 0) queueMicrotask(() => void flush());
        pending.push({ entry, resolve });
      });
    },
  };
}

declare module "@notefig/core" {
  interface CoreModules {
    harnesses: HarnessesApi;
  }
}

/**
 * The boot loads the rows (moving an older version's settings into them)
 * and then runs the launch scan: one install check of every harness per
 * app session. Where there is no shell (a browser) it comes back "couldn't
 * check" and records nothing; a failure is logged and never fails startup
 * — the last verdicts stand until a check succeeds. It then keeps what
 * sessions report each harness offers.
 */
export const harnessesModule = defineModule({
  name: "harnesses",
  // Platform: the rows' database, and the shell an install check runs in.
  // KV: settings an older version kept there.
  needs: [platformModule, kvModule],
  register: (ctx) =>
    createHarnesses({
      persistence: ctx.use("platform").db.get(),
      kv: ctx.use("kv"),
      proc: ctx.use("platform").proc,
      hooks: ctx.hooks,
    }),
  boot: (harnesses) => {
    void harnesses.rescan().catch((error) => {
      console.warn("Startup harness discovery failed:", error);
    });
    return harnesses.track();
  },
});
