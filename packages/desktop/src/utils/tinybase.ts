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
  // If basePath changed, reset the store and persister
  if (currentBasePath !== null && currentBasePath !== basePath) {
    console.log(
      `[TinyBase] Workspace path changed from ${currentBasePath} to ${basePath}, resetting store`,
    );

    // Stop auto-load on old persister
    if (persister) {
      await persister.stopAutoLoad();
    }

    // Reset state
    store = null;
    persister = null;
    currentBasePath = null;
  }

  // Return existing store if already initialized for this path
  if (store && persister && currentBasePath === basePath) {
    return [store, persister];
  }

  // Create new store and persister
  console.log(`[TinyBase] Initializing new store for workspace: ${basePath}`);
  currentBasePath = basePath;
  store = createStore();
  persister = platformAdapter.getPersister(store, basePath);

  await persister.load();
  await persister.startAutoLoad();

  return [store, persister];
}
