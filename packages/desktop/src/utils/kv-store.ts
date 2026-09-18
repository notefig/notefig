/**
 * Namespaced key-value storage over the SQLite `db` surface (MET-124).
 *
 * This module is the whole KV boundary. Before the cutover the collection here
 * fronted a `platformAdapter.kv` surface (tauri-plugin-store's `kv.json` on
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
import { persistedCollectionOptions } from "@tanstack/db-sqlite-persistence-core";
import { platformAdapter } from "@/adapters";

export interface KvRow {
  key: string;
  value: unknown;
}

type KvCollection = ReturnType<typeof createKvCollection>;

const collectionRegistry = new Map<string, KvCollection>();

function createKvCollection(namespace: string) {
  return createCollection(
    persistedCollectionOptions<KvRow, string>({
      // Explicit, always: the default is a random UUID, and the table name is
      // derived from it — so an omitted id silently writes to a fresh table
      // every launch and nothing ever comes back.
      id: `kv:${namespace}`,
      getKey: (item) => item.key,
      persistence: platformAdapter.db.get(),
      // No write-through handlers: the persisted wrapper commits every
      // mutation to SQLite itself.
    }),
  );
}

export function getOrCreateKvCollection(namespace: string) {
  const existing = collectionRegistry.get(namespace);
  if (existing) {
    return existing;
  }

  const collection = createKvCollection(namespace);
  collectionRegistry.set(namespace, collection);
  return collection;
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

/**
 * The imperative half, for the callers that run outside React: telemetry
 * bootstrap (before the tree mounts), the startup harness scan, tunnel pairing,
 * the debug panel. Reads wait for hydration; writes resolve once the row is
 * durable, which `stateWhenReady()` does *not* guarantee.
 */
export async function readKv<T>(
  namespace: string,
  key: string,
): Promise<T | undefined> {
  const collection = getOrCreateKvCollection(namespace);
  await collection.preload();
  return collection.get(key)?.value as T | undefined;
}

export async function readAllKv<T>(
  namespace: string,
): Promise<Record<string, T>> {
  const collection = getOrCreateKvCollection(namespace);
  await collection.preload();
  const values: Record<string, T> = {};
  for (const row of collection.values()) {
    values[row.key] = row.value as T;
  }
  return values;
}

export async function writeKv<T>(
  namespace: string,
  key: string,
  value: T,
): Promise<void> {
  const collection = getOrCreateKvCollection(namespace);
  await (await upsert(collection, key, value)).isPersisted.promise;
}

export async function removeKv(namespace: string, key: string): Promise<void> {
  const collection = getOrCreateKvCollection(namespace);
  await collection.preload();
  if (!collection.get(key)) return;
  await collection.delete(key).isPersisted.promise;
}

export function useKv<T>(namespace: string) {
  const collection = getOrCreateKvCollection(namespace);

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
