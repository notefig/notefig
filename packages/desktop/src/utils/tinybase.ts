import { createStore, type Store } from "tinybase";
import { createCustomPersister } from "tinybase/persisters";

let store: Store | null;
let interval: NodeJS.Timeout | undefined;
export function getSingltonStore() {
  if (store) {
    return store;
  }
  store = createStore();
  const persister = createCustomPersister(
    store!,
    async () => {
      return undefined;
    },
    async (getContent) => console.log(getContent()),
    (listener) => (interval = setInterval(listener, 1000)),
    () => clearInterval(interval),
  );
  persister.load();
  setTimeout(() => persister.save(), 10000);
  return store;
}
