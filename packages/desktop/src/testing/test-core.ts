/**
 * A core for unit tests: the layout module (plus whatever the test adds,
 * e.g. `tabsModule`) over a URL the test controls, a fresh query client,
 * and a platform whose database is in memory and the test's own (give
 * `platform` for the surfaces a test exercises). A module reaching a
 * surface the test left out fails loudly.
 */
import { QueryClient } from "@tanstack/react-query";
import { createCore, type AnyModule, type Core } from "@notefig/core";
import type { IPlatformAdapter } from "@/adapters/platform-adapter.interface";
import { layoutModule, type UrlState } from "@/entities/layout";
import { createNodeTestDb } from "./node-db";
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
  options: {
    url?: UrlState;
    modules?: AnyModule[];
    platform?: Partial<IPlatformAdapter>;
  } = {},
): Core {
  const core = createCore({
    services: {
      url: options.url ?? memoryUrlState(),
      queryClient: new QueryClient(),
      platform: { db: createNodeTestDb(), ...options.platform },
    } as never,
    modules: [layoutModule, ...(options.modules ?? [])],
    workspaceKey,
  });
  return core;
}
