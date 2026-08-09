import { useLiveQuery, createCollection } from "@tanstack/react-db";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { queryClient } from "@/entities/query-client";
import { platformAdapter } from "@/adapters";

export interface KvRow {
  key: string;
  value: unknown;
}

const collectionRegistry = new Map<
  string,
  ReturnType<typeof createKvCollection>
>();

function createKvCollection(namespace: string) {
  return createCollection(
    queryCollectionOptions<KvRow, string>({
      queryKey: ["kv", namespace],
      queryClient,

      queryFn: async (): Promise<KvRow[]> => {
        const raw = await platformAdapter.kv.getAllKv<unknown>(namespace);
        return Object.entries(raw).map(([key, value]) => ({ key, value }));
      },

      getKey: (item) => item.key,

      onInsert: async ({ transaction }) => {
        for (const m of transaction.mutations) {
          await platformAdapter.kv.setKv(
            namespace,
            m.modified.key,
            m.modified.value,
          );
        }
      },

      onUpdate: async ({ transaction }) => {
        for (const m of transaction.mutations) {
          await platformAdapter.kv.setKv(
            namespace,
            m.modified.key,
            m.modified.value,
          );
        }
      },

      onDelete: async ({ transaction }) => {
        for (const m of transaction.mutations) {
          await platformAdapter.kv.deleteKv(namespace, m.key);
        }
      },
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
    const existing = collection.get(key);
    if (existing) {
      collection.update(key, (draft) => {
        draft.value = value;
      });
    } else {
      collection.insert({ key, value });
    }
  }

  function get(key: string): T | undefined {
    const row = collection.get(key);
    return row?.value as T | undefined;
  }

  function remove(key: string) {
    collection.delete(key);
  }

  function clear() {
    const allKeys = rows.map((r) => r.key);
    for (const key of allKeys) {
      collection.delete(key);
    }
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
