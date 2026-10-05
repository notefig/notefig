/**
 * A core for unit tests: the layout module (plus whatever the test adds,
 * e.g. `tabsModule`) over a URL the test controls and a fresh query
 * client, installed as the app core so `appCore()` callers find it. Services a test does not exercise
 * are left out; a module that needs one fails loudly at `createCore`.
 */
import { QueryClient } from "@tanstack/react-query";
import { createCore, type AnyModule, type Core } from "@notefig/core";
import { installAppCore } from "@/core/current";
import { layoutModule, type UrlState } from "@/entities/layout";
import { workspaceKey } from "@/utils/path";

/** A URL that lives only in memory. */
export function memoryUrlState(initialSearch = ""): UrlState {
  let search = initialSearch;
  const listeners = new Set<() => void>();
  return {
    search: () => search,
    setSearch(next) {
      search = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/** The test environment's real `window.location`. */
export function windowUrlState(): UrlState {
  const listeners = new Set<() => void>();
  return {
    search: () => window.location.search,
    setSearch(next, options) {
      const url = `${window.location.pathname}${next}`;
      if (options?.replace) window.history.replaceState(null, "", url);
      else window.history.pushState(null, "", url);
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

export function createTestCore(
  options: { url?: UrlState; modules?: AnyModule[] } = {},
): Core {
  const core = createCore({
    services: {
      url: options.url ?? memoryUrlState(),
      queryClient: new QueryClient(),
    } as never,
    modules: [layoutModule, ...(options.modules ?? [])],
    workspaceKey,
  });
  installAppCore(core);
  return core;
}
