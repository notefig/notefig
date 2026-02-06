import { createStore, type Store } from "tinybase";
import { platformAdapter } from "../adapters";
import type { Persister } from "tinybase/persisters";

// Map of basePath -> Store
const stores: Record<string, Store> = {};
// Map of basePath -> Persister
const persisters: Record<string, Persister> = {};

/**
 * Get or create a store for the given basePath.
 * Returns immediately with a store (may be empty if first time).
 * Data loads asynchronously in the background.
 */
export function getOrCreateStore(basePath: string): Store {
  // Return existing store if available
  if (stores[basePath]) {
    console.log(`[TinyBase] Using existing store for: ${basePath}`);
    return stores[basePath];
  }

  console.log(`[TinyBase] Creating new store for: ${basePath}`);

  // Create store synchronously
  const store = createStore();
  stores[basePath] = store;

  // Get persister and start loading in background
  const persister = platformAdapter.getPersister(store, basePath);
  persisters[basePath] = persister;

  // Start async operations but don't wait for them
  // The store will populate as data loads
  persister
    .load()
    .then(() => {
      console.log(`[TinyBase] Loaded data for: ${basePath}`);
      return persister.startAutoLoad();
    })
    .then(() => {
      return persister.startAutoSave();
    })
    .then(() => {
      console.log(`[TinyBase] Auto-save/load started for: ${basePath}`);
    })
    .catch((error) => {
      console.error(`[TinyBase] Failed to load store for ${basePath}:`, error);
    });

  // Return store immediately (may be empty initially)
  return store;
}

/**
 * Get an existing store. Throws if not initialized.
 * Use getOrCreateStore() instead for automatic creation.
 * @deprecated Use getOrCreateStore instead
 */
export function getStore(basePath: string): Store {
  if (!stores[basePath]) {
    console.warn(
      `[TinyBase] Store not found for ${basePath}, creating it now. Consider using getOrCreateStore() instead.`,
    );
    return getOrCreateStore(basePath);
  }
  return stores[basePath];
}

/**
 * Check if a store exists for a given basePath
 */
export function hasStore(basePath: string): boolean {
  return !!stores[basePath];
}

/**
 * Clean up a store for a given basePath
 */
export async function cleanupStore(basePath: string): Promise<void> {
  const persister = persisters[basePath];
  if (persister) {
    console.log(`[TinyBase] Cleaning up store for: ${basePath}`);
    await persister.stopAutoSave();
    await persister.stopAutoLoad();
    delete persisters[basePath];
    delete stores[basePath];
  }
}

/**
 * @deprecated Use getOrCreateStore instead
 */
export async function getSingltonStore(
  basePath: string,
): Promise<[Store, Persister]> {
  const store = getOrCreateStore(basePath);
  const persister = persisters[basePath];
  return [store, persister];
}
