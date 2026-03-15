import type { LayoutNode } from "@/components/dockable";
import type { WindowNode } from "@/components/dockable/utils/serializeLayout";

/**
 * Deep-clone a layout tree, adding a new tab to the first Window and selecting it.
 * Preserves all panel splits, sizes, and tab ordering.
 */
export function addTabToLayout(
  layout: LayoutNode[],
  tabId: string,
): LayoutNode[] {
  let added = false;
  function walk(nodes: LayoutNode[]): LayoutNode[] {
    return nodes.map((node) => {
      if (node.type === "Window" && !added) {
        added = true;
        return {
          ...node,
          children: [...node.children, tabId],
          selected: tabId,
        };
      }
      if (node.type === "Panel") {
        return { ...node, children: walk(node.children) };
      }
      return node;
    });
  }
  return walk(layout);
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
