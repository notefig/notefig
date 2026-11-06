/**
 * Layout entity — the dockable tab layout as a core module.
 *
 * The URL state (`?layout=<json>`) stays the single source of truth; this
 * module is the only code that reads or writes that param. That state is
 * the in-memory `url` service; the browser's URL mirrors it after paint.
 * It reaches the URL through that service rather than React Router hooks, so the layout
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
import { afterPaint, coalescedAfterPaint } from "@/utils/after-paint";

/**
 * The URL as the layout needs it. Implemented in memory over the app's
 * router, which mirrors it after paint (`urlStateFromRouter`), and over
 * `window.location` in tests. `setSearch` must update `search()` and call
 * the listeners synchronously: the app reads its state from here, never
 * from the router.
 */
export interface UrlState {
  /** The route's path; the app's own surface is "/". */
  pathname(): string;
  search(): string;
  setSearch(search: string, options?: { replace?: boolean }): void;
  /** Called after every location change; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
}

interface DataRouterLike {
  state: { location: { pathname: string; search: string } };
  navigate(
    to: { search: string },
    options?: { replace?: boolean },
  ): Promise<void>;
  subscribe(listener: () => void): () => void;
}

/**
 * The app's URL state, held in memory with the router as its mirror.
 *
 * The search (the tab layout, the sidebar, open dialogs) changes on every
 * tab click. Navigating the router for each one put a `history` write, the
 * router's own notification and a transition render of everything under
 * it between the click and the frame that answers it. Here a write lands
 * in memory, synchronously, and the app's listeners hear it at once; the
 * router is told after the frame has painted, once for every write in
 * between (one history entry if any of them pushed).
 *
 * A change the router makes itself — back/forward, a router link — is
 * adopted: it replaces the state and drops a mirror still pending, so the
 * URL the user navigated to wins.
 */
export function urlStateFromRouter(
  router: DataRouterLike,
  defer: (task: () => void) => () => void = afterPaint,
): UrlState {
  let search = router.state.location.search;
  let pathname = router.state.location.pathname;
  let pushPending = false;
  // Searches handed to the router and not yet seen back from it: its
  // notification for one of these is our own mirror, not a navigation.
  const mirroring = new Set<string>();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  const mirror = coalescedAfterPaint(() => {
    const replace = !pushPending;
    pushPending = false;
    if (router.state.location.search === search) return;
    mirroring.add(search);
    void router.navigate({ search }, { replace });
  }, defer);

  router.subscribe(() => {
    const location = router.state.location;
    const pathChanged = location.pathname !== pathname;
    pathname = location.pathname;
    if (mirroring.delete(location.search)) {
      if (pathChanged) notify();
      return;
    }
    if (location.search !== search) {
      search = location.search;
      pushPending = false;
      mirror.cancel();
      notify();
    } else if (pathChanged) {
      notify();
    }
  });

  return {
    pathname: () => pathname,
    search: () => search,
    setSearch: (next, options) => {
      const normalized = next === "?" ? "" : next;
      if (normalized === search) return;
      search = normalized;
      if (!options?.replace) pushPending = true;
      mirror.schedule();
      notify();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
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
