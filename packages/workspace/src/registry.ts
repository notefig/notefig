/**
 * Generic flat id → live-object registry, replacing the pattern that used to
 * be hand-rolled once per subsystem in desktop (editor instances, workspace
 * collections, git services, agent tasks).
 */
export interface Registry<T> {
  register(id: string, value: T): void;
  unregister(id: string): void;
  get(id: string): T | undefined;
  has(id: string): boolean;
  clear(): void;
}

export function createRegistry<T>(): Registry<T> {
  const map = new Map<string, T>();
  return {
    register(id, value) {
      map.set(id, value);
    },
    unregister(id) {
      map.delete(id);
    },
    get(id) {
      return map.get(id);
    },
    has(id) {
      return map.has(id);
    },
    clear() {
      map.clear();
    },
  };
}
