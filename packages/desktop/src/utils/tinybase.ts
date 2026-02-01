import { createStore, type Store } from "tinybase";
import { Persister, createCustomPersister } from "tinybase/persisters";
import { platformAdapter } from "../adapters";

let store: Store | null = null;
let persister: Persister | null = null;

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
