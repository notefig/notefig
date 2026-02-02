import { createStore, type Store } from "tinybase";
import { useTable } from "tinybase/ui-react";
import { platformAdapter } from "../adapters";
import type { Persister } from "tinybase/persisters";

let store: Store | null = null;
let persister: Persister | null = null;

export function getStore() {
  return store;
}

export async function getSingltonStore(
  basePath: string,
): Promise<[Store, Persister]> {
  if (store && persister) {
    return [store, persister];
  }
  store = createStore();
  persister = platformAdapter.getPersister(store, basePath);
  await persister.load();
  await persister.startAutoLoad();
  return [store, persister];
}
