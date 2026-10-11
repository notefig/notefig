/**
 * What each harness offers — its switchable settings (the model among
 * them) and its slash commands and skills — kept beyond the sessions that
 * reported it: `core.harnessCatalog`. ACP only reports these once a session
 * exists, and the composer needs them before one does.
 *
 * Rows come from sessions (`"agent:catalog"`, announced by agent-service,
 * which writes no catalog itself). One row per harness is app-wide: its
 * settings, and the commands a probe finds (steps 7–8 of MET-221). One row
 * per harness and workspace holds the commands sessions reported there, a
 * project's own skills included — those are never shown in another
 * workspace.
 */
import { createCollection } from "@tanstack/react-db";
import {
  persistedCollectionOptions,
  type PersistedCollectionPersistence,
} from "@tanstack/db-sqlite-persistence-core";
import {
  newHarnessCatalogId,
  type AvailableCommand,
  type HarnessDefinition,
  type SessionConfigSelect,
} from "@notefig/shared/agent";
import { defineModule, type CoreHookMap, type Hooks } from "@notefig/core";
import { platformModule } from "@/core/services";
import { workspaceKey } from "@/utils/path";
import { harnessesModule, type HarnessesApi } from "./harnesses";

/** The collection id, and so the SQLite table the rows land in. */
export const HARNESS_CATALOG_COLLECTION_ID = "harness-catalog";

/** What one harness offers, app-wide or in one workspace. */
export interface HarnessCatalogRow {
  /** hct_… */
  catalogId: string;
  harnessId: string;
  /** Null: app-wide (settings, and the commands a probe found). Set: the
   *  commands sessions reported in that workspace. */
  workspacePath: string | null;
  /** The full list, the model among them; null = not known. Only the
   *  app-wide row has it. */
  configOptions: SessionConfigSelect[] | null;
  /** Commands and skills in one list; null = not known. */
  commands: AvailableCommand[] | null;
  /** Where the row last came from. */
  source: "probe" | "session";
  /** When it last did. */
  fetchedAt: number;
  /** The definition everything on the row was reported under
   *  (`definitionFingerprint`): a report under another clears the rest. */
  definitionFingerprint: string;
}

function createCatalogCollection(persistence: PersistedCollectionPersistence) {
  return createCollection(
    persistedCollectionOptions<HarnessCatalogRow, string>({
      id: HARNESS_CATALOG_COLLECTION_ID,
      getKey: (row) => row.catalogId,
      persistence,
    }),
  );
}

export type HarnessCatalogCollection = ReturnType<typeof createCatalogCollection>;

/**
 * A short, stable stand-in for what a harness is spawned with — the
 * command, its args and its env — so a row can tell it was reported under
 * another one without storing the env itself twice.
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

/** A harness's offer as a view shows it: the workspace's commands over the
 *  app-wide ones (by name), and the app-wide settings. */
export interface HarnessCatalog {
  configOptions: SessionConfigSelect[] | null;
  commands: AvailableCommand[] | null;
}

/** The rows for one harness, merged for a workspace (or none). */
export function catalogFor(
  rows: Iterable<HarnessCatalogRow>,
  workspacePath: string | null,
): HarnessCatalog {
  let appWide: HarnessCatalogRow | undefined;
  let inWorkspace: HarnessCatalogRow | undefined;
  const key = workspacePath === null ? null : workspaceKey(workspacePath);
  for (const row of rows) {
    if (row.workspacePath === null) appWide = row;
    else if (key !== null && workspaceKey(row.workspacePath) === key) {
      inWorkspace = row;
    }
  }
  return {
    configOptions: appWide?.configOptions ?? null,
    commands: mergeCommands(appWide?.commands ?? null, inWorkspace?.commands ?? null),
  };
}

function mergeCommands(
  appWide: AvailableCommand[] | null,
  inWorkspace: AvailableCommand[] | null,
): AvailableCommand[] | null {
  if (!inWorkspace) return appWide;
  if (!appWide) return inWorkspace;
  const byName = new Map(appWide.map((command) => [command.name, command]));
  for (const command of inWorkspace) byName.set(command.name, command);
  return [...byName.values()];
}

export interface HarnessCatalogApi {
  /** Every row, app-wide and per workspace. */
  readonly collection: HarnessCatalogCollection;
  /** Resolves once every report heard so far is durable. */
  settled(): Promise<void>;
  /** Boot: keep what sessions report. Returns the unsubscribe. */
  track(): () => void;
}

export function createHarnessCatalog({
  persistence,
  hooks,
  harnesses,
}: {
  persistence: PersistedCollectionPersistence;
  /** Where sessions announce what their harness offers. */
  hooks: Pick<Hooks, "on">;
  /** The definition a report was made under. */
  harnesses: Pick<HarnessesApi, "harness" | "ready">;
}): HarnessCatalogApi {
  const rows = createCatalogCollection(persistence);

  const rowFor = (harnessId: string, workspacePath: string | null) => {
    const key = workspacePath === null ? null : workspaceKey(workspacePath);
    return rows.toArray.find(
      (row) =>
        row.harnessId === harnessId &&
        (row.workspacePath === null
          ? key === null
          : key !== null && workspaceKey(row.workspacePath) === key),
    );
  };

  /** Write a harness's row for a workspace (or app-wide), creating it if
   *  it has none. Every field but the ones `change` sets is the stored
   *  row's — unless that was reported under another definition, when it
   *  no longer holds and is unknown again, as on a new row. */
  const upsert = (
    harnessId: string,
    workspacePath: string | null,
    stamp: Pick<HarnessCatalogRow, "source" | "fetchedAt" | "definitionFingerprint">,
    change: (row: HarnessCatalogRow) => void,
  ): Promise<unknown> => {
    const existing = rowFor(harnessId, workspacePath);
    if (existing) {
      const sameDefinition =
        existing.definitionFingerprint === stamp.definitionFingerprint;
      return rows.update(existing.catalogId, (draft) => {
        if (!sameDefinition) {
          draft.configOptions = null;
          draft.commands = null;
        }
        Object.assign(draft, stamp);
        change(draft);
      }).isPersisted.promise;
    }
    const row: HarnessCatalogRow = {
      catalogId: newHarnessCatalogId(),
      harnessId,
      workspacePath,
      configOptions: null,
      commands: null,
      ...stamp,
    };
    change(row);
    return rows.insert(row).isPersisted.promise;
  };

  const write = async (detail: CoreHookMap["agent:catalog"]): Promise<void> => {
    await Promise.all([rows.preload(), harnesses.ready()]);
    // A session of a harness deleted since: nothing to keep it for.
    if (!harnesses.harness(detail.harnessId).definition()) return;
    const stamp = {
      source: "session" as const,
      fetchedAt: Date.now(),
      // The session's own: it may predate an edit, and then its offer is
      // already stale.
      definitionFingerprint: definitionFingerprint(detail.harness),
    };
    const { configOptions, commands } = detail;
    // Commands stay in their workspace: they may be that project's own
    // skills. App-wide commands are the probe's to find.
    if (commands) {
      await upsert(detail.harnessId, detail.workspacePath, stamp, (row) => {
        row.commands = commands;
      });
    }
    if (configOptions) {
      await upsert(detail.harnessId, null, stamp, (row) => {
        row.configOptions = configOptions;
      });
    }
  };

  // Writes run one at a time, each to durability, so two reports for one
  // harness can never both find no row and insert two.
  let writes: Promise<void> = Promise.resolve();
  const record = (detail: CoreHookMap["agent:catalog"]) => {
    writes = writes
      .then(() => write(detail))
      .catch((error) => console.error("Failed to record a harness's catalog:", error));
  };

  return {
    collection: rows,
    settled: () => writes,
    track: () => hooks.on("agent:catalog", record),
  };
}

declare module "@notefig/core" {
  interface CoreModules {
    harnessCatalog: HarnessCatalogApi;
  }
}

/** What each harness offers, kept from what its sessions report. */
export const harnessCatalogModule = defineModule({
  name: "harnessCatalog",
  // Harnesses: the definition each report was made under.
  needs: [platformModule, harnessesModule],
  register: (ctx) =>
    createHarnessCatalog({
      persistence: ctx.use("platform").db.get(),
      hooks: ctx.hooks,
      harnesses: ctx.use("harnesses"),
    }),
  boot: (catalog) => catalog.track(),
});
