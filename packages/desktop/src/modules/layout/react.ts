/**
 * The layout from React.
 */
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useCore } from "@notefig/core/react";
import type { LayoutNode } from "@/components/dockable";
import { extractTabIds, findLayoutSelectedTab } from "@/utils/layout-codec";

export interface LayoutState {
  layout: LayoutNode[];
  openTabs: string[];
  /** The selected tab of the first window that has one, or null. */
  layoutSelectedTabId: string | null;
}

/** The layout, re-rendering when it changes. */
export function useLayout(): LayoutState {
  const { layout: api } = useCore();
  const layout = useSyncExternalStore(api.subscribe, api.read, api.read);
  return useMemo(
    () => ({
      layout,
      openTabs: extractTabIds(layout),
      layoutSelectedTabId: findLayoutSelectedTab(layout),
    }),
    [layout],
  );
}

/** The parsed search, one parse per distinct search string. */
let parsedSearch = "";
let parsedParams = new URLSearchParams();
function paramsOf(search: string): URLSearchParams {
  if (search !== parsedSearch) {
    parsedSearch = search;
    parsedParams = new URLSearchParams(search);
  }
  return parsedParams;
}

/**
 * One search param, re-rendering only when that param changes. The URL
 * changes on every tab click (it carries the layout); a component that
 * reads `?settings` must not render for those.
 */
export function useSearchParam(key: string): string | null {
  const url = useCore().use("url");
  const read = () => paramsOf(url.search()).get(key);
  return useSyncExternalStore(url.subscribe, read, read);
}

/** The whole search string, for the few readers that show all of it. */
export function useSearch(): string {
  const url = useCore().use("url");
  return useSyncExternalStore(url.subscribe, url.search, url.search);
}

export type SetSearchParams = (
  update: (prev: URLSearchParams) => URLSearchParams,
  options?: { replace?: boolean },
) => void;

/**
 * Change search params from the live URL state. Stable across renders, and
 * reads nothing at render time, so a component that only writes params
 * never re-renders for them.
 */
export function useSetSearchParams(): SetSearchParams {
  const url = useCore().use("url");
  return useCallback<SetSearchParams>(
    (update, options) => {
      const next = update(new URLSearchParams(url.search())).toString();
      url.setSearch(next ? `?${next}` : "", options);
    },
    [url],
  );
}
