import { createStore, type Store } from "tinybase";
import { platformAdapter } from "../adapters";
import type { Persister } from "tinybase/persisters";

let store: Store | null = null;
let persister: Persister | null = null;
let currentBasePath: string | null = null;

export function getStore() {
  if (!store) {
    throw new Error(
      "Store not initialized. Please use getSingltonStore with a basePath first.",
    );
  }
  return store;
}

export async function getSingltonStore(
  basePath: string,
): Promise<[Store, Persister]> {
  if (currentBasePath !== null && currentBasePath !== basePath) {
    if (persister) {
      await persister.stopAutoLoad();
    }
    store = null;
    persister = null;
    currentBasePath = null;
  }
  if (store && persister && currentBasePath === basePath) {
    return [store, persister];
  }
  currentBasePath = basePath;
  store = createStore();
  persister = platformAdapter.getPersister(store, basePath);
  await persister.load();
  await persister.startAutoLoad();
  return [store, persister];
}
