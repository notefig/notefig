/**
 * The pure dockable-layout codec: parse the URL-encoded LayoutNode tree and
 * walk it. A true leaf (only a type import) so ANY module can use it —
 * including debug-panel, the crash fallback that must not depend on the
 * entity modules that might be implicated in whatever crashed. The tabs
 * entity re-exports these as its public API.
 */
import type { LayoutNode } from "@/components/dockable";

export const LAYOUT_PARAM = "layout";

/**
 * Parse a JSON-encoded LayoutNode[] from a string. Returns [] on any failure.
 */
export function parseLayout(raw: string | null): LayoutNode[] {
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
export function extractTabIds(nodes: LayoutNode[]): string[] {
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
 * This is layout-derived state, not focus-derived active UI state.
 */
export function findLayoutSelectedTab(nodes: LayoutNode[]): string | null {
  for (const node of nodes) {
    if (node.type === "Window" && node.selected) {
      return node.selected;
    }
    if (node.type === "Panel") {
      const found = findLayoutSelectedTab(node.children);
      if (found) return found;
    }
  }
  return null;
}
