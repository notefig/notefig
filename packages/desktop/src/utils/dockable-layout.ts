import type { LayoutNode } from "@/components/dockable";
import type { WindowNode } from "@/components/dockable/utils/serializeLayout";

export type PaneDirection = "up" | "down" | "left" | "right";

export interface WindowRect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
}

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
 * Deep-clone a layout tree, swapping a tab id in place: same window, same
 * child index, selection follows. Used by the rename-open-tab flow (a file
 * tab's id IS its path) — must NOT go through handleLayoutChange, whose
 * removed-id diff would dispose the old id.
 */
export function renameTabInLayout(
  layout: LayoutNode[],
  oldId: string,
  newId: string,
): LayoutNode[] {
  return mapLayout(layout, (windowNode) => {
    if (!windowNode.children.includes(oldId)) {
      return windowNode;
    }
    return {
      ...windowNode,
      children: windowNode.children.map((id) => (id === oldId ? newId : id)),
      selected: windowNode.selected === oldId ? newId : windowNode.selected,
    };
  });
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

          if (newChildren.length === 0) return null;

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
          if (newChildren.length === 0) return null;
          return { ...node, children: newChildren };
        }
        return node;
      })
      .filter((node): node is LayoutNode => node !== null);
  }

  return walk(layout);
}

// ---------------------------------------------------------------------------
// Window/pane navigation helpers
// ---------------------------------------------------------------------------

/** Return every window in depth-first (render) order. */
export function collectWindows(nodes: LayoutNode[]): WindowNode[] {
  const windows: WindowNode[] = [];
  for (const node of nodes) {
    if (node.type === "Window") {
      windows.push(node);
    } else if (node.type === "Panel") {
      windows.push(...collectWindows(node.children));
    }
  }
  return windows;
}

function totalSizeOf(nodes: LayoutNode[]): number {
  return nodes.reduce((sum, node) => sum + (node.size ?? 1), 0);
}

function sizeRatio(node: LayoutNode, totalSize: number, count: number): number {
  return totalSize === 0 ? 1 / count : (node.size ?? 1) / totalSize;
}

/** Split children horizontally and recurse or record a window. */
function assignRowRects(
  nodes: LayoutNode[],
  x: number,
  y: number,
  w: number,
  h: number,
  rects: WindowRect[],
): void {
  const totalSize = totalSizeOf(nodes);
  let offset = 0;

  for (const node of nodes) {
    const childW = sizeRatio(node, totalSize, nodes.length) * w;
    if (node.type === "Window") {
      const left = x + offset;
      rects.push({
        id: node.id,
        x: left,
        y,
        w: childW,
        h,
        cx: left + childW / 2,
        cy: y + h / 2,
      });
    } else {
      const childOrientation = node.orientation ?? "column";
      assignRects(
        node.children,
        childOrientation,
        x + offset,
        y,
        childW,
        h,
        rects,
      );
    }
    offset += childW;
  }
}

/** Split children vertically and recurse or record a window. */
function assignColumnRects(
  nodes: LayoutNode[],
  x: number,
  y: number,
  w: number,
  h: number,
  rects: WindowRect[],
): void {
  const totalSize = totalSizeOf(nodes);
  let offset = 0;

  for (const node of nodes) {
    const childH = sizeRatio(node, totalSize, nodes.length) * h;
    if (node.type === "Window") {
      const top = y + offset;
      rects.push({
        id: node.id,
        x,
        y: top,
        w,
        h: childH,
        cx: x + w / 2,
        cy: top + childH / 2,
      });
    } else {
      const childOrientation = node.orientation ?? "row";
      assignRects(
        node.children,
        childOrientation,
        x,
        y + offset,
        w,
        childH,
        rects,
      );
    }
    offset += childH;
  }
}

function assignRects(
  nodes: LayoutNode[],
  parentOrientation: "row" | "column",
  x: number,
  y: number,
  w: number,
  h: number,
  rects: WindowRect[],
): void {
  if (nodes.length === 0 || w <= 0 || h <= 0) return;
  if (parentOrientation === "row") {
    assignRowRects(nodes, x, y, w, h, rects);
  } else {
    assignColumnRects(nodes, x, y, w, h, rects);
  }
}

/** Assign each window a normalized rectangle derived from panel splits. */
export function assignWindowRects(layout: LayoutNode[]): WindowRect[] {
  const rects: WindowRect[] = [];
  assignRects(layout, "row", 0, 0, 1, 1, rects);
  return rects;
}

/**
 * Find the window adjacent to `fromWindowId` in a cardinal direction.
 * Windows are given normalized rectangles from panel splits; navigation
 * picks the nearest in-bounds window, penalising perpendicular offset so
 * directly-adjacent panes win over diagonally-placed ones.
 */
export function findAdjacentWindow(
  layout: LayoutNode[],
  fromWindowId: string,
  direction: PaneDirection,
): WindowNode | null {
  const rects = assignWindowRects(layout);
  const from = rects.find((rect) => rect.id === fromWindowId);
  if (!from) return null;

  let best: WindowRect | null = null;
  let bestScore = Infinity;

  for (const rect of rects) {
    if (rect.id === fromWindowId) continue;

    let inDirection = false;
    let primaryDist = 0;
    let secondaryDist = 0;

    switch (direction) {
      case "right":
        inDirection = rect.x >= from.x + from.w;
        primaryDist = rect.x - from.x;
        secondaryDist = Math.abs(rect.cy - from.cy);
        break;
      case "left":
        inDirection = rect.x + rect.w <= from.x;
        primaryDist = from.x + from.w - (rect.x + rect.w);
        secondaryDist = Math.abs(rect.cy - from.cy);
        break;
      case "down":
        inDirection = rect.y >= from.y + from.h;
        primaryDist = rect.y - from.y;
        secondaryDist = Math.abs(rect.cx - from.cx);
        break;
      case "up":
        inDirection = rect.y + rect.h <= from.y;
        primaryDist = from.y + from.h - (rect.y + rect.h);
        secondaryDist = Math.abs(rect.cx - from.cx);
        break;
    }

    if (!inDirection) continue;
    const score = primaryDist + secondaryDist * 2;
    if (score < bestScore) {
      bestScore = score;
      best = rect;
    }
  }

  if (!best) return null;
  return findWindowById(layout, best.id);
}

/** Cycle through windows in depth-first order. */
export function findWindowByOffset(
  layout: LayoutNode[],
  fromWindowId: string,
  offset: number,
): WindowNode | null {
  const windows = collectWindows(layout);
  if (windows.length <= 1) return null;
  const index = windows.findIndex((w) => w.id === fromWindowId);
  const start = index >= 0 ? index : 0;
  const nextIndex = (start + offset + windows.length) % windows.length;
  return windows[nextIndex];
}
