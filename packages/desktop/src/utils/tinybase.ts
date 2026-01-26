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

const initialFiles = [
  {
    id: "5",
    name: "Welcome",
    type: "file",
  },
  {
    id: "folder-1",
    name: "Projects",
    type: "folder",
    children: [
      { id: "6", name: "Project A", type: "file" },
      { id: "7", name: "Project B", type: "file" },
    ],
  },
  {
    id: "folder-2",
    name: "Notes",
    type: "folder",
    children: [
      { id: "8", name: "Meeting Notes", type: "file" },
      { id: "9", name: "Ideas", type: "file" },
    ],
  },
];
