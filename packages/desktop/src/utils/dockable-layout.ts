import type { LayoutNode } from "@/components/dockable";
import type { WindowNode } from "@/components/dockable/utils/serializeLayout";

export type OpenFileIntent = "replace" | "new-tab";

export interface OpenFileInLayoutOptions {
  tabId: string;
  intent: OpenFileIntent;
  targetWindowId?: string;
  /**
   * When the file is already open in a different window than
   * targetWindowId, move its tab there instead of selecting it in place.
   * Only explicit placement gestures (drag-and-drop onto a window) should
   * set this — targetWindowId alone often just carries the active-window
   * fallback.
   */
  moveIfOpen?: boolean;
}

function mapLayout(
  nodes: LayoutNode[],
  mapWindow: (node: WindowNode) => WindowNode,
): LayoutNode[] {
  return nodes.map((node) => {
    if (node.type === "Window") {
      return mapWindow(node);
    }

    if (node.type === "Panel") {
      return {
        ...node,
        children: mapLayout(node.children, mapWindow),
      };
    }

    return node;
  });
}

/**
 * Deep-clone a layout tree, adding a new tab to the first Window and selecting it.
 * Preserves all panel splits, sizes, and tab ordering.
 */
export function addTabToLayout(
  layout: LayoutNode[],
  tabId: string,
): LayoutNode[] {
  const firstWindow = findFirstWindow(layout);
  if (!firstWindow) {
    return createInitialLayout(tabId);
  }

  return openTabInWindow(layout, firstWindow.id, tabId, "new-tab");
}

/**
 * Deep-clone a layout tree, setting `selected` to `tabId` in the Window
 * that contains it. Other windows are left unchanged.
 */
export function selectTabInLayout(
  layout: LayoutNode[],
  tabId: string,
): LayoutNode[] {
  return layout.map((node) => {
    if (node.type === "Window") {
      if (node.children.includes(tabId)) {
        return { ...node, selected: tabId };
      }
      return node;
    }
    if (node.type === "Panel") {
      return { ...node, children: selectTabInLayout(node.children, tabId) };
    }
    return node;
  });
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
 * Find the first window node in the layout tree.
 */
export function findFirstWindow(nodes: LayoutNode[]): WindowNode | null {
  for (const node of nodes) {
    if (node.type === "Window") {
      return node;
    }

    if (node.type === "Panel") {
      const childWindow = findFirstWindow(node.children);
      if (childWindow) {
        return childWindow;
      }
    }
  }

  return null;
}

/**
 * Find a window node by its id.
 */
export function findWindowById(
  nodes: LayoutNode[],
  windowId: string,
): WindowNode | null {
  for (const node of nodes) {
    if (node.type === "Window" && node.id === windowId) {
      return node;
    }

    if (node.type === "Panel") {
      const childWindow = findWindowById(node.children, windowId);
      if (childWindow) {
        return childWindow;
      }
    }
  }

  return null;
}

/**
 * Find the first window that contains the given tab id.
 */
export function findWindowContainingTab(
  nodes: LayoutNode[],
  tabId: string,
): WindowNode | null {
  for (const node of nodes) {
    if (node.type === "Window" && node.children.includes(tabId)) {
      return node;
    }

    if (node.type === "Panel") {
      const childWindow = findWindowContainingTab(node.children, tabId);
      if (childWindow) {
        return childWindow;
      }
    }
  }

  return null;
}

/**
 * Resolve a target window id, with fallback to the first window.
 */
export function resolveTargetWindowId(
  layout: LayoutNode[],
  preferredWindowId?: string,
): string | null {
  if (preferredWindowId && findWindowById(layout, preferredWindowId)) {
    return preferredWindowId;
  }

  return findFirstWindow(layout)?.id ?? null;
}

/**
 * Replace the selected tab in a specific window and select the replacement.
 */
export function replaceSelectedTabInWindow(
  layout: LayoutNode[],
  windowId: string,
  nextTabId: string,
): LayoutNode[] {
  return mapLayout(layout, (windowNode) => {
    if (windowNode.id !== windowId) return windowNode;

    if (windowNode.children.length === 0) {
      return { ...windowNode, children: [nextTabId], selected: nextTabId };
    }

    const selectedIndex = windowNode.children.indexOf(windowNode.selected);
    const replaceIndex = selectedIndex >= 0 ? selectedIndex : 0;
    const nextChildren = [...windowNode.children];
    nextChildren[replaceIndex] = nextTabId;

    return {
      ...windowNode,
      children: nextChildren,
      selected: nextTabId,
    };
  });
}

/**
 * Open a tab in a specific window, either appending or replacing selected tab.
 */
export function openTabInWindow(
  layout: LayoutNode[],
  windowId: string,
  tabId: string,
  mode: OpenFileIntent,
): LayoutNode[] {
  if (mode === "replace") {
    return replaceSelectedTabInWindow(layout, windowId, tabId);
  }

  return mapLayout(layout, (windowNode) => {
    if (windowNode.id !== windowId) return windowNode;
    return {
      ...windowNode,
      children: [...windowNode.children, tabId],
      selected: tabId,
    };
  });
}

/**
 * Open a file with explicit intent. If already open, selects existing tab.
 */
export function openFileInLayout(
  layout: LayoutNode[],
  options: OpenFileInLayoutOptions,
): LayoutNode[] {
  const { tabId, intent, targetWindowId, moveIfOpen } = options;

  const existingWindow = findWindowContainingTab(layout, tabId);
  if (existingWindow) {
    if (
      moveIfOpen &&
      targetWindowId &&
      existingWindow.id !== targetWindowId &&
      findWindowById(layout, targetWindowId)
    ) {
      // Explicit placement gesture: relocate the tab. Removing it first
      // also collapses the source window when it becomes empty, matching
      // dnd-kit tab moves.
      const without = removeTabFromLayout(layout, tabId);
      return openTabInWindow(without, targetWindowId, tabId, "new-tab");
    }
    return selectTabInLayout(layout, tabId);
  }

  if (layout.length === 0) {
    return createInitialLayout(tabId);
  }

  const resolvedTargetWindowId = resolveTargetWindowId(layout, targetWindowId);
  if (!resolvedTargetWindowId) {
    return createInitialLayout(tabId);
  }

  return openTabInWindow(layout, resolvedTargetWindowId, tabId, intent);
}

/**
 * Create an initial layout with a single window containing one tab.
 */
export function createInitialLayout(tabId: string): LayoutNode[] {
  return [
    {
      type: "Window" as const,
      id: "editor-window",
      children: [tabId],
      selected: tabId,
      size: 1,
    },
  ];
}

/**
 * Remove a tab from the layout tree.
 * If a window becomes empty, it's removed from the layout.
 */
export function removeTabFromLayout(
  layout: LayoutNode[],
  tabId: string,
): LayoutNode[] {
  function walk(nodes: LayoutNode[]): LayoutNode[] {
    return nodes
      .map((node) => {
        if (node.type === "Window") {
          const newChildren = node.children.filter((id) => id !== tabId);

          // If window is empty, remove it (return null to be filtered)
          if (newChildren.length === 0) return null;

          // If selected tab was removed, select first remaining tab
          const newSelected =
            node.selected === tabId ? newChildren[0] : node.selected;

          return {
            ...node,
            children: newChildren,
            selected: newSelected,
          };
        }
        if (node.type === "Panel") {
          const newChildren = walk(node.children);
          // If panel has no children left, remove it
          if (newChildren.length === 0) return null;
          return { ...node, children: newChildren };
        }
        return node;
      })
      .filter((node): node is LayoutNode => node !== null);
  }

  return walk(layout);
}
