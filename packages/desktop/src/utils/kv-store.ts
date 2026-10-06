/**
 * Namespaced key-value storage over the SQLite `db` surface (MET-124).
 *
 * This module is the whole KV boundary, as `core.kv` (built from the
 * platform's db that core hands it). Before the cutover the collection here
 * fronted a platform `kv` surface (tauri-plugin-store's `kv.json` on
 * desktop, `localStorage` on web) and a handful of callers reached past it to
 * that surface directly — which meant their writes were invisible to `useKv`
 * subscribers until the next refetch. There is now nothing to reach past: the
 * imperative helpers below go through the same collections the hooks read.
 *
 * The `{ key, value }` row shape is deliberately kept. It is what the eight
 * consumers already speak, and settings-sized data gains nothing from columns;
 * `agentTasksCollection` is the row-shaped case and is typed properly instead.
 */
import { useLiveQuery, createCollection } from "@tanstack/react-db";
// From the platform-neutral core, not either platform package — this module is
// shared, and the two platform packages differ only in how they open a database.
import {
  persistedCollectionOptions,
  type PersistedCollectionPersistence,
} from "@tanstack/db-sqlite-persistence-core";
import { defineModule } from "@notefig/core";
import { useModule } from "@notefig/core/react";

export interface KvRow {
  key: string;
  value: unknown;
}

type KvCollection = ReturnType<typeof createKvCollection>;
type Persistence = PersistedCollectionPersistence;

function createKvCollection(namespace: string, persistence: Persistence) {
  return createCollection(
    persistedCollectionOptions<KvRow, string>({
      // Explicit, always: the default is a random UUID, and the table name is
      // derived from it — so an omitted id silently writes to a fresh table
      // every launch and nothing ever comes back.
      id: `kv:${namespace}`,
      getKey: (item) => item.key,
      persistence,
      // No write-through handlers: the persisted wrapper commits every
      // mutation to SQLite itself.
    }),
  );
}

/**
 * Insert-or-update — the collection distinguishes the two, callers don't.
 *
 * Never before hydration: a mutation issued before the namespace has loaded
 * is assigned a stream position from what the persistence layer has
 * observed so far — before hydration, the very position the previous
 * session already used — and the adapter drops it as already applied. The
 * value shows in memory and is gone on the next launch
 * (kv-store-hydration.test.tsx pins this). In steady state `preload()` is a
 * resolved promise, so the write is deferred by one microtask at most.
 */
async function upsert(collection: KvCollection, key: string, value: unknown) {
  await collection.preload();
  return collection.get(key)
    ? collection.update(key, (draft) => {
        draft.value = value;
      })
    : collection.insert({ key, value });
}

/** The KV store — `core.kv`. Reads wait for hydration; writes resolve
 *  once the row is durable, which `stateWhenReady()` does *not* guarantee. */
export interface KvApi {
  /** A namespace's collection, created on first use. */
  collection(namespace: string): KvCollection;
  read<T>(namespace: string, key: string): Promise<T | undefined>;
  readAll<T>(namespace: string): Promise<Record<string, T>>;
  write<T>(namespace: string, key: string, value: T): Promise<void>;
  remove(namespace: string, key: string): Promise<void>;
}

/** KV over the persistence it is handed; namespaces open lazily. */
export function createKv(persistence: () => Persistence): KvApi {
  const namespaces = new Map<string, KvCollection>();
  const collection = (namespace: string) => {
    let existing = namespaces.get(namespace);
    if (!existing) {
      existing = createKvCollection(namespace, persistence());
      namespaces.set(namespace, existing);
    }
    return existing;
  };
  return {
    collection,
    async read<T>(namespace: string, key: string) {
      const rows = collection(namespace);
      await rows.preload();
      return rows.get(key)?.value as T | undefined;
    },
    async readAll<T>(namespace: string) {
      const rows = collection(namespace);
      await rows.preload();
      const values: Record<string, T> = {};
      for (const row of rows.values()) values[row.key] = row.value as T;
      return values;
    },
    async write(namespace, key, value) {
      await (
        await upsert(collection(namespace), key, value)
      ).isPersisted.promise;
    },
    async remove(namespace, key) {
      const rows = collection(namespace);
      await rows.preload();
      if (!rows.get(key)) return;
      await rows.delete(key).isPersisted.promise;
    },
  };
}

declare module "@notefig/core" {
  interface CoreModules {
    kv: KvApi;
  }
}

export const kvModule = defineModule({
  name: "kv",
  needs: ["platform"],
  register: (ctx) => createKv(() => ctx.use("platform").db.get()),
});

export function useKv<T>(namespace: string) {
  const collection = useModule("kv").collection(namespace);

  const { data: rows = [], isReady } = useLiveQuery(
    (q) =>
      q.from({ item: collection }).select(({ item }) => ({
        key: item.key,
        value: item.value,
      })),
    [namespace],
  );

  const values: Record<string, T> = {};
  for (const row of rows) {
    values[row.key] = row.value as T;
  }

  function set(key: string, value: T) {
    void upsert(collection, key, value);
  }

  function get(key: string): T | undefined {
    const row = collection.get(key);
    return row?.value as T | undefined;
  }

  // Deletes wait for hydration for the same reason as `upsert`: a delete
  // issued before the row has loaded finds nothing to delete, and the row
  // comes back with the load.
  function remove(key: string) {
    void collection.preload().then(() => {
      if (collection.get(key)) collection.delete(key);
    });
  }

  function clear() {
    const allKeys = rows.map((r) => r.key);
    void collection.preload().then(() => {
      for (const key of allKeys) {
        if (collection.get(key)) collection.delete(key);
      }
    });
  }

  return {
    values,
    isReady,
    set,
    get,
    remove,
    clear,
  };
}
