/**
 * A KV namespace from React: its rows live, and writes through the collection.
 */
import { useLiveQuery } from "@tanstack/react-db";
import { upsert } from "./kv";
import { useCore } from "@notefig/core/react";

export function useKv<T>(namespace: string) {
  const collection = useCore().kv.collection(namespace);

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
