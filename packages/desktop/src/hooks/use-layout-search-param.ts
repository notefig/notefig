import { useMemo, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import type { LayoutNode } from "@danfessler/react-dockable";

const LAYOUT_PARAM = "layout";

/**
 * Parse a JSON-encoded LayoutNode[] from a string.
 * Returns [] on any failure.
 */
function parseLayout(raw: string | null): LayoutNode[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as LayoutNode[];
    return [];
  } catch {
    return [];
  }
}

/**
 * Walk the LayoutNode tree and collect all tab IDs.
 */
function extractTabIds(nodes: LayoutNode[]): string[] {
  const ids: string[] = [];
  for (const node of nodes) {
    if (node.type === "Window") {
      ids.push(...node.children);
    } else if (node.type === "Panel") {
      ids.push(...extractTabIds(node.children));
    }
  }
  return ids;
}

/**
 * Find the selected tab in the first window that has one.
 */
function findSelectedTab(nodes: LayoutNode[]): string | null {
  for (const node of nodes) {
    if (node.type === "Window" && node.selected) {
      return node.selected;
    }
    if (node.type === "Panel") {
      const found = findSelectedTab(node.children);
      if (found) return found;
    }
  }
  return null;
}

export interface UseLayoutSearchParam {
  /** The full Dockable layout tree from the URL */
  layout: LayoutNode[];
  /** Write a new layout to the URL (pushes history entry) */
  setLayout: (newLayout: LayoutNode[]) => void;
  /** All tab IDs extracted from the layout */
  openTabs: string[];
  /** The currently selected tab ID, or null */
  activeTabId: string | null;
}

/**
 * Hook that stores the Dockable LayoutNode[] in a URL search param
 * (`?layout=<json>`). The URL is the single source of truth.
 *
 * Other search params (e.g. `settings`) are preserved.
 */
export function useLayoutSearchParam(): UseLayoutSearchParam {
  const [searchParams, setSearchParams] = useSearchParams();

  const layout = useMemo(
    () => parseLayout(searchParams.get(LAYOUT_PARAM)),
    [searchParams],
  );

  const setLayout = useCallback(
    (newLayout: LayoutNode[]) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (newLayout.length === 0) {
          next.delete(LAYOUT_PARAM);
        } else {
          next.set(LAYOUT_PARAM, JSON.stringify(newLayout));
        }
        return next;
      });
    },
    [setSearchParams],
  );

  const openTabs = useMemo(() => extractTabIds(layout), [layout]);
  const activeTabId = useMemo(() => findSelectedTab(layout), [layout]);

  return { layout, setLayout, openTabs, activeTabId };
}
