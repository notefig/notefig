import { useCallback, useMemo, type ReactElement, type RefObject } from "react";
import type { LayoutNode, TabProps } from "@/components/dockable";
import { useLayoutSearchParam } from "./use-layout-search-param";
import {
  addTabToLayout,
  findFirstWindow,
  findWindowById,
  selectTabInLayout,
  createInitialLayout,
  extractTabIds,
} from "@/utils/dockable-layout";
import { disposeEditor } from "@/components/editor/editor-store";
import type { FileTreeNode } from "@/utils/fs";

export interface UseDockableTabsOptions {
  /**
   * Called when tabs need to be rendered.
   * Return an array of Dockable.Tab elements.
   */
  renderTabs: (tabIds: string[]) => ReactElement<TabProps>[];

  /**
   * Optional filter function to determine if a file can be opened as a tab.
   * If not provided, all files can be opened.
   */
  canOpenFile?: (file: FileTreeNode) => boolean;

  /**
   * Optional container ref used to detect the focused dockable window.
   */
  dockableRef?: RefObject<HTMLElement | null>;
}

export interface UseDockableTabsResult {
  /** Current layout state */
  layout: LayoutNode[];

  /** All open tab IDs */
  openTabs: string[];

  /** Currently active tab ID */
  activeTabId: string | null;

  /** Rendered tab elements */
  tabs: ReactElement<TabProps>[];

  /** Handle file selection from file tree */
  handleFileSelect: (file: FileTreeNode) => void;

  /** Handle layout changes from Dockable */
  handleLayoutChange: (newLayout: LayoutNode[]) => void;

  /** Programmatically open a tab */
  openTab: (tabId: string) => void;

  /** Programmatically close a tab */
  closeTab: (tabId: string) => void;

  /** Programmatically switch to a tab */
  selectTab: (tabId: string) => void;

  /** Switch to the next tab (wraps around) */
  selectNextTab: () => void;

  /** Switch to the previous tab (wraps around) */
  selectPrevTab: () => void;
}

/**
 * Hook for managing dockable tabs with URL-based state persistence.
 *
 * Handles:
 * - Opening/closing tabs
 * - Tab selection
 * - Layout state synchronization with URL
 * - Editor instance cleanup
 *
 * @example
 * ```tsx
 * const { tabs, layout, handleLayoutChange, handleFileSelect } = useDockableTabs({
 *   renderTabs: (tabIds) => tabIds.map(id => (
 *     <Dockable.Tab key={id} id={id} name={getName(id)}>
 *       <Editor fileId={id} />
 *     </Dockable.Tab>
 *   )),
 *   canOpenFile: (file) => file.type === 'file' && isTextFile(file.path),
 * });
 *
 * return (
 *   <Dockable.Root layout={layout} onChange={handleLayoutChange}>
 *     {tabs}
 *   </Dockable.Root>
 * );
 * ```
 */
export function useDockableTabs(
  options: UseDockableTabsOptions,
): UseDockableTabsResult {
  const { renderTabs, canOpenFile, dockableRef } = options;
  const { layout, setLayout, openTabs, activeTabId } = useLayoutSearchParam();

  // Render tabs using the provided render function
  const tabs = useMemo(() => renderTabs(openTabs), [renderTabs, openTabs]);

  // Handle file selection from file tree
  const handleFileSelect = useCallback(
    (file: FileTreeNode) => {
      if (file.type !== "file") return;

      // Check if file can be opened (if filter provided)
      if (canOpenFile && !canOpenFile(file)) {
        console.warn(`File cannot be opened as tab: ${file.path}`);
        return;
      }

      if (openTabs.includes(file.path)) {
        // Tab already open — update selection in the layout
        setLayout(selectTabInLayout(layout, file.path));
        return;
      }

      // New tab: merge into the current layout
      let nextLayout: LayoutNode[];
      if (layout.length > 0) {
        nextLayout = addTabToLayout(layout, file.path);
      } else {
        // First tab ever — create a fresh single-window layout
        nextLayout = createInitialLayout(file.path);
      }

      setLayout(nextLayout);
    },
    [layout, openTabs, setLayout, canOpenFile],
  );

  // Handle layout changes from Dockable
  const handleLayoutChange = useCallback(
    (newLayout: LayoutNode[]) => {
      // Dispose editors for any tabs that Dockable removed (e.g. via drag to close)
      const newTabIds = extractTabIds(newLayout);
      const removed = openTabs.filter((id) => !newTabIds.includes(id));
      removed.forEach((id) => disposeEditor(id));

      // Write the full layout to the URL
      setLayout(newLayout);
    },
    [openTabs, setLayout],
  );

  // Programmatic tab management
  const openTab = useCallback(
    (tabId: string) => {
      if (openTabs.includes(tabId)) {
        setLayout(selectTabInLayout(layout, tabId));
        return;
      }

      const nextLayout =
        layout.length > 0
          ? addTabToLayout(layout, tabId)
          : createInitialLayout(tabId);
      setLayout(nextLayout);
    },
    [layout, openTabs, setLayout],
  );

  const closeTab = useCallback(
    (tabId: string) => {
      if (!openTabs.includes(tabId)) return;

      disposeEditor(tabId);

      // Remove tab from layout
      const nextLayout = layout
        .map((node) => {
          if (node.type === "Window") {
            const newChildren = node.children.filter((id) => id !== tabId);
            if (newChildren.length === 0) return null;

            const newSelected =
              node.selected === tabId ? newChildren[0] : node.selected;
            return { ...node, children: newChildren, selected: newSelected };
          }
          return node;
        })
        .filter((node): node is LayoutNode => node !== null);

      setLayout(nextLayout);
    },
    [layout, openTabs, setLayout],
  );

  const selectTab = useCallback(
    (tabId: string) => {
      if (!openTabs.includes(tabId)) return;
      setLayout(selectTabInLayout(layout, tabId));
    },
    [layout, openTabs, setLayout],
  );

  const getActiveWindow = useCallback(() => {
    const root = dockableRef?.current;
    const activeElement = document.activeElement;

    if (
      root &&
      activeElement instanceof HTMLElement &&
      root.contains(activeElement)
    ) {
      const windowElement = activeElement.closest<HTMLElement>(
        "[data-dockable-window-id]",
      );
      const windowId = windowElement?.dataset.dockableWindowId;

      if (windowId) {
        const activeWindow = findWindowById(layout, windowId);
        if (activeWindow) {
          return activeWindow;
        }
      }
    }

    return findFirstWindow(layout);
  }, [dockableRef, layout]);

  const selectNextTab = useCallback(() => {
    const activeWindow = getActiveWindow();
    if (!activeWindow || activeWindow.children.length <= 1) return;

    const currentIndex = activeWindow.children.indexOf(activeWindow.selected);
    if (currentIndex === -1) return;

    const nextTabId =
      activeWindow.children[(currentIndex + 1) % activeWindow.children.length];
    setLayout(selectTabInLayout(layout, nextTabId));
  }, [getActiveWindow, layout, setLayout]);

  const selectPrevTab = useCallback(() => {
    const activeWindow = getActiveWindow();
    if (!activeWindow || activeWindow.children.length <= 1) return;

    const currentIndex = activeWindow.children.indexOf(activeWindow.selected);
    if (currentIndex === -1) return;

    const prevTabId =
      activeWindow.children[
        (currentIndex - 1 + activeWindow.children.length) %
          activeWindow.children.length
      ];
    setLayout(selectTabInLayout(layout, prevTabId));
  }, [getActiveWindow, layout, setLayout]);

  return {
    layout,
    openTabs,
    activeTabId,
    tabs,
    handleFileSelect,
    handleLayoutChange,
    openTab,
    closeTab,
    selectTab,
    selectNextTab,
    selectPrevTab,
  };
}
