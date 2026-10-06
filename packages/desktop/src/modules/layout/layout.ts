/**
 * Layout entity — the dockable tab layout as a core module.
 *
 * The URL (`?layout=<json>`) stays the single source of truth; this module
 * is the only code that reads or writes that param. It reaches the URL
 * through the `url` service rather than React Router hooks, so the layout
 * can be read and changed from anywhere — an agent tool, a drop handler,
 * a hotkey — not only from inside a component that rendered under the
 * router. React reads it through `useLayout()`.
 */
import { defineModule } from "@notefig/core";
import type { LayoutNode } from "@/components/dockable";
import {
  LAYOUT_PARAM,
  extractTabIds,
  findLayoutSelectedTab,
  parseLayout,
} from "@/utils/layout-codec";
import { urlModule } from "@/core/services";

/**
 * The URL as the layout needs it. Implemented over a data router in the
 * app (`urlStateFromRouter`) and over a memory router in tests. `setSearch`
 * must update `search()` synchronously — React Router's data routers do
 * when no route has a loader.
 */
export interface UrlState {
  search(): string;
  setSearch(search: string, options?: { replace?: boolean }): void;
  /** Called after every location change; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
}

interface DataRouterLike {
  state: { location: { search: string } };
  navigate(
    to: { search: string },
    options?: { replace?: boolean },
  ): Promise<void>;
  subscribe(listener: () => void): () => void;
}

export function urlStateFromRouter(router: DataRouterLike): UrlState {
  return {
    search: () => router.state.location.search,
    setSearch: (search, options) => {
      void router.navigate({ search }, { replace: options?.replace });
    },
    subscribe: (listener) => router.subscribe(listener),
  };
}

export interface LayoutUpdateOptions {
  /** Replace the history entry instead of pushing one. */
  replace?: boolean;
  /**
   * Change other search params in the same navigation — for a write that
   * must land atomically with the layout (closing the settings modal as a
   * file opens from it).
   */
  params?: (params: URLSearchParams) => void;
}

export interface LayoutApi {
  read(): LayoutNode[];
  openTabIds(): string[];
  /** The selected tab of the first window that has one. */
  selectedTabId(): string | null;
  /** Write a new layout (pushes a history entry). */
  update(
    next: LayoutNode[] | ((current: LayoutNode[]) => LayoutNode[]),
    options?: LayoutUpdateOptions,
  ): void;
  /** Called after every layout change; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
}

declare module "@notefig/core" {
  interface CoreModules {
    layout: LayoutApi;
  }
}

export function createLayout(url: UrlState): LayoutApi {
  // Parse once per distinct param value, so `read()` returns a stable
  // reference until the layout actually changes (useSyncExternalStore).
  let cachedRaw: string | null | undefined;
  let cached: LayoutNode[] = [];
  const read = (): LayoutNode[] => {
    const raw = new URLSearchParams(url.search()).get(LAYOUT_PARAM);
    if (raw !== cachedRaw) {
      cachedRaw = raw;
      cached = parseLayout(raw);
    }
    return cached;
  };

  return {
    read,
    openTabIds: () => extractTabIds(read()),
    selectedTabId: () => findLayoutSelectedTab(read()),
    update(next, options) {
      const params = new URLSearchParams(url.search());
      const resolved = typeof next === "function" ? next(read()) : next;
      if (resolved.length === 0) params.delete(LAYOUT_PARAM);
      else params.set(LAYOUT_PARAM, JSON.stringify(resolved));
      options?.params?.(params);
      const search = params.toString();
      url.setSearch(search ? `?${search}` : "", { replace: options?.replace });
    },
    subscribe(listener) {
      // The router notifies on every location change; only a change to the
      // layout param is a layout change.
      let last = read();
      return url.subscribe(() => {
        const next = read();
        if (next === last) return;
        last = next;
        listener();
      });
    },
  };
}

export const layoutModule = defineModule({
  name: "layout",
  needs: [urlModule],
  register: (ctx) => createLayout(ctx.use("url")),
});
