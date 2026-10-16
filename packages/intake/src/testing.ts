import type { KeyValueStorage } from "./store";

/** An in-memory KeyValueStorage with DurableObjectStorage's list ordering. */
export function memoryStorage(): KeyValueStorage & { keys(): string[] } {
  const data = new Map<string, unknown>();
  return {
    async get<T>(key: string) {
      return structuredClone(data.get(key)) as T | undefined;
    },
    async put<T>(key: string, value: T) {
      data.set(key, structuredClone(value));
    },
    async delete(key: string) {
      return data.delete(key);
    },
    async list<T>({ prefix, end }: { prefix: string; end?: string }) {
      const matching = [...data.keys()]
        .filter((key) => key.startsWith(prefix) && (end === undefined || key < end))
        .sort();
      return new Map(matching.map((key) => [key, data.get(key) as T]));
    },
    keys: () => [...data.keys()].sort(),
  };
}
