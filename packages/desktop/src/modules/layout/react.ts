/**
 * The layout from React.
 */
import { useMemo, useSyncExternalStore } from "react";
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
