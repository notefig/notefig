import {
  useCallback,
  useMemo,
  useRef,
  useEffect,
  useState,
  type ReactElement,
  type RefObject,
} from "react";
import { useHotkey } from "@tanstack/react-hotkeys";
import type { LayoutNode, TabProps } from "@/components/dockable";
import { useLayoutSearchParam, extractTabIds } from "@/entities/tabs";
import {
  findFirstWindow,
  findWindowById,
  openFileInLayout,
  type OpenFileInLayoutOptions,
  removeTabFromLayout,
  selectTabInLayout,
} from "@/utils/dockable-layout";
import {
  disposeEditor,
  focusEditor,
  requestEditorFocus,
  setActiveEditorFocusTarget,
  getSelectedText as getSelectedTextForEditor,
} from "@/components/editor/editor-store";
import type { FileTreeNode } from "@/utils/fs";

export interface UseDockableTabsOptions {
  renderTabs: (tabIds: string[]) => ReactElement<TabProps>[];

  canOpenFile?: (file: FileTreeNode) => boolean;

  dockableRef?: RefObject<HTMLElement | null>;
}

export interface UseDockableTabsResult {
  layout: LayoutNode[];

  openTabs: string[];

  activeTabId: string | null;

  tabs: ReactElement<TabProps>[];

  handleFileSelect: (
    file: FileTreeNode,
    options?: Omit<OpenFileInLayoutOptions, "tabId">,
  ) => void;

  handleLayoutChange: (newLayout: LayoutNode[]) => void;

  openFile: (options: OpenFileInLayoutOptions) => void;

  closeTab: (tabId: string) => void;

  getFocusedTabId: () => string | null;

  closeActiveTab: () => void;

  selectTab: (tabId: string) => void;

  selectTabAtIndex: (index: number) => void;

  selectNextTab: () => void;

  selectPrevTab: () => void;

  focusActiveEditor: () => boolean;

  getSelectedText: () => string | undefined;
}

/**
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
  const { layout, setLayout, openTabs, layoutSelectedTabId } =
    useLayoutSearchParam();
  const lastFocusedWindowIdRef = useRef<string | null>(null);
  const [, setFocusedWindowId] = useState<string | null>(null);

  const tabs = useMemo(() => renderTabs(openTabs), [renderTabs, openTabs]);

  useEffect(() => {
    const root = dockableRef?.current;
    if (!root) return;

    const handleFocusIn = (event: FocusEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      const windowEl = target.closest<HTMLElement>("[data-dockable-window-id]");
      const nextFocusedWindowId = windowEl?.dataset.dockableWindowId;
      if (nextFocusedWindowId) {
        lastFocusedWindowIdRef.current = nextFocusedWindowId;
        setFocusedWindowId((current) =>
          current === nextFocusedWindowId ? current : nextFocusedWindowId,
        );
      }
    };

    root.addEventListener("focusin", handleFocusIn);
    return () => {
      root.removeEventListener("focusin", handleFocusIn);
    };
  }, [dockableRef]);

  const getActiveWindow = useCallback(() => {
    const root = dockableRef?.current;
    const activeElement = document.activeElement;

    // 1) If focus is currently inside dockable, use that window
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

    // 2) Fallback to last-focused window (if still present)
    if (lastFocusedWindowIdRef.current) {
      const rememberedWindow = findWindowById(
        layout,
        lastFocusedWindowIdRef.current,
      );
      if (rememberedWindow) return rememberedWindow;
    }

    // 3) Fallback to window containing layout-selected tab
    if (layoutSelectedTabId) {
      const windowWithActive = layout.find((node) =>
        "selected" in node ? node.selected === layoutSelectedTabId : false,
      );
      if (windowWithActive && "selected" in windowWithActive) {
        return windowWithActive as any;
      }
    }

    // 4) Fallback to first window
    return findFirstWindow(layout);
  }, [dockableRef, layout, layoutSelectedTabId]);

  const getFocusedTabId = useCallback(() => {
    return getActiveWindow()?.selected ?? layoutSelectedTabId;
  }, [getActiveWindow, layoutSelectedTabId]);

  const activeTabId = getFocusedTabId();

  useEffect(() => {
    setActiveEditorFocusTarget(activeTabId);
  }, [activeTabId]);

  useEffect(() => {
    const tabId = getFocusedTabId();
    if (!tabId) return;

    requestEditorFocus(tabId, {
      when: "when-mounted",
      reason: "tab-selected",
    });
  }, [getFocusedTabId]);

  const getActiveWindowId = useCallback(() => {
    return getActiveWindow()?.id ?? null;
  }, [getActiveWindow]);

  const handleFileSelect = useCallback(
    (file: FileTreeNode, options?: Omit<OpenFileInLayoutOptions, "tabId">) => {
      if (file.type !== "file") return;

      if (canOpenFile && !canOpenFile(file)) {
        console.warn(`File cannot be opened as tab: ${file.path}`);
        return;
      }

      setLayout((currentLayout) => {
        return openFileInLayout(currentLayout, {
          tabId: file.path,
          intent: options?.intent ?? "replace",
          targetWindowId:
            options?.targetWindowId ?? getActiveWindowId() ?? undefined,
        });
      });
    },
    [setLayout, canOpenFile, getActiveWindowId],
  );

  const handleLayoutChange = useCallback(
    (newLayout: LayoutNode[]) => {
      // Dispose editors for any tabs that Dockable removed (e.g. via drag to close)
      const newTabIds = extractTabIds(newLayout);
      const removed = openTabs.filter((id) => !newTabIds.includes(id));
      removed.forEach((id) => disposeEditor(id));

      setLayout(newLayout);
    },
    [openTabs, setLayout],
  );

  const openFile = useCallback(
    (options: OpenFileInLayoutOptions) => {
      setLayout((currentLayout) =>
        openFileInLayout(currentLayout, {
          ...options,
          targetWindowId:
            options.targetWindowId ?? getActiveWindowId() ?? undefined,
        }),
      );
    },
    [setLayout, getActiveWindowId],
  );

  const closeTab = useCallback(
    (tabId: string) => {
      if (!openTabs.includes(tabId)) return;

      disposeEditor(tabId);

      setLayout((currentLayout) => removeTabFromLayout(currentLayout, tabId));
    },
    [openTabs, setLayout],
  );

  const selectTab = useCallback(
    (tabId: string) => {
      if (!openTabs.includes(tabId)) return;
      setLayout((currentLayout) => selectTabInLayout(currentLayout, tabId));
    },
    [openTabs, setLayout],
  );

  const closeActiveTab = useCallback(() => {
    const tabId = getFocusedTabId();

    if (!tabId) return;

    closeTab(tabId);
  }, [getFocusedTabId, closeTab]);

  const focusActiveEditor = useCallback(() => {
    const tabId = getFocusedTabId();
    if (!tabId) return false;
    return focusEditor(tabId);
  }, [getFocusedTabId]);

  const getSelectedText = useCallback(() => {
    const tabId = getFocusedTabId();
    if (!tabId) return undefined;
    return getSelectedTextForEditor(tabId);
  }, [getFocusedTabId]);

  const selectTabAtIndex = useCallback(
    (index: number) => {
      const activeWindow = getActiveWindow();
      const tabId = activeWindow?.children[index];

      if (!tabId) return;

      setLayout((currentLayout) => selectTabInLayout(currentLayout, tabId));
    },
    [getActiveWindow, setLayout],
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
    setLayout((currentLayout) => selectTabInLayout(currentLayout, nextTabId));
  }, [getActiveWindow, setLayout]);

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
    setLayout((currentLayout) => selectTabInLayout(currentLayout, prevTabId));
  }, [getActiveWindow, setLayout]);

  return {
    layout,
    openTabs,
    activeTabId,
    tabs,
    handleFileSelect,
    handleLayoutChange,
    openFile,
    closeTab,
    getFocusedTabId,
    closeActiveTab,
    selectTab,
    selectTabAtIndex,
    selectNextTab,
    selectPrevTab,
    focusActiveEditor,
    getSelectedText,
  };
}
