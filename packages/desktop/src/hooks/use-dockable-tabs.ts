import { useCallback, useMemo, type ReactElement, type RefObject } from "react";
import { useHotkey } from "@tanstack/react-hotkeys";
import type { LayoutNode, TabProps } from "@/components/dockable";
import { useLayoutSearchParam } from "./use-layout-search-param";
import {
  addTabToLayout,
  findFirstWindow,
  findWindowById,
  removeTabFromLayout,
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

  /** Get the selected tab in the focused window */
  getFocusedTabId: () => string | null;

  /** Close the selected tab in the focused window */
  closeActiveTab: () => void;

  /** Programmatically switch to a tab */
  selectTab: (tabId: string) => void;

  /** Switch to a tab by index within the focused window */
  selectTabAtIndex: (index: number) => void;

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

      setLayout(removeTabFromLayout(layout, tabId));
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

  const getFocusedTabId = useCallback(() => {
    return getActiveWindow()?.selected ?? activeTabId;
  }, [getActiveWindow, activeTabId]);

  const closeActiveTab = useCallback(() => {
    const tabId = getFocusedTabId();

    if (!tabId) return;

    closeTab(tabId);
  }, [getFocusedTabId, closeTab]);

  const selectTabAtIndex = useCallback(
    (index: number) => {
      const activeWindow = getActiveWindow();
      const tabId = activeWindow?.children[index];

      if (!tabId) return;

      setLayout(selectTabInLayout(layout, tabId));
    },
    [getActiveWindow, layout, setLayout],
  );

  const dockableHotkeyOptions = useMemo(
    () => ({
      enabled: openTabs.length > 0,
      target: dockableRef,
    }),
    [dockableRef, openTabs.length],
  );

  useHotkey(
    "Mod+W",
    () => {
      closeActiveTab();
    },
    dockableHotkeyOptions,
  );

  useHotkey(
    "Control+Tab",
    () => {
      selectNextTab();
    },
    dockableHotkeyOptions,
  );

  useHotkey(
    "Control+Shift+Tab",
    () => {
      selectPrevTab();
    },
    dockableHotkeyOptions,
  );

  useHotkey(
    { key: "1", mod: true },
    () => {
      selectTabAtIndex(0);
    },
    dockableHotkeyOptions,
  );

  useHotkey(
    { key: "2", mod: true },
    () => {
      selectTabAtIndex(1);
    },
    dockableHotkeyOptions,
  );

  useHotkey(
    { key: "3", mod: true },
    () => {
      selectTabAtIndex(2);
    },
    dockableHotkeyOptions,
  );

  useHotkey(
    { key: "4", mod: true },
    () => {
      selectTabAtIndex(3);
    },
    dockableHotkeyOptions,
  );

  useHotkey(
    { key: "5", mod: true },
    () => {
      selectTabAtIndex(4);
    },
    dockableHotkeyOptions,
  );

  useHotkey(
    { key: "6", mod: true },
    () => {
      selectTabAtIndex(5);
    },
    dockableHotkeyOptions,
  );

  useHotkey(
    { key: "7", mod: true },
    () => {
      selectTabAtIndex(6);
    },
    dockableHotkeyOptions,
  );

  useHotkey(
    { key: "8", mod: true },
    () => {
      selectTabAtIndex(7);
    },
    dockableHotkeyOptions,
  );

  useHotkey(
    { key: "9", mod: true },
    () => {
      selectTabAtIndex(8);
    },
    dockableHotkeyOptions,
  );

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
    getFocusedTabId,
    closeActiveTab,
    selectTab,
    selectTabAtIndex,
    selectNextTab,
    selectPrevTab,
  };
}
