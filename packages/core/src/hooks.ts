import type { CoreHookMap, HookName } from "./types";

type Handler<K extends HookName> = (
  payload: CoreHookMap[K],
) => void | Promise<void>;

export interface Hooks {
  /** Subscribe; returns the unsubscribe. Handlers run in subscription order. */
  on<K extends HookName>(name: K, handler: Handler<K>): () => void;
  /**
   * Fire and forget. A handler that throws (or rejects) is reported and the
   * rest still run: one module's failure must not starve the others.
   */
  emit<K extends HookName>(name: K, payload: CoreHookMap[K]): void;
  /**
   * Run every handler one after another, awaiting each. For hooks whose
   * handlers must finish before the caller moves on (closing, shutdown).
   * A failure is reported and the rest still run; never thrown, but the
   * caller gets the failures back, for a step that must not go on past one.
   */
  emitSerial<K extends HookName>(
    name: K,
    payload: CoreHookMap[K],
  ): Promise<unknown[]>;
}

export function createHooks(
  onError: (error: unknown, hook: string) => void = (error, hook) =>
    console.error(`[hooks] ${hook} handler failed:`, error),
): Hooks {
  const handlers = new Map<string, Set<Handler<HookName>>>();

  const listFor = (name: string) => [...(handlers.get(name) ?? [])];

  return {
    on(name, handler) {
      let set = handlers.get(name);
      if (!set) {
        set = new Set();
        handlers.set(name, set);
      }
      const entry = handler as Handler<HookName>;
      set.add(entry);
      return () => {
        set.delete(entry);
      };
    },
    emit(name, payload) {
      for (const handler of listFor(name)) {
        try {
          const result = handler(payload as never);
          if (result instanceof Promise) {
            result.catch((error: unknown) => onError(error, name));
          }
        } catch (error) {
          onError(error, name);
        }
      }
    },
    async emitSerial(name, payload) {
      const failures: unknown[] = [];
      for (const handler of listFor(name)) {
        try {
          await handler(payload as never);
        } catch (error) {
          onError(error, name);
          failures.push(error);
        }
      }
      return failures;
    },
  };
}
