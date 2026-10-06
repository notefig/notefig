import {
  useCallback,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { useHotkey } from "@tanstack/react-hotkeys";
import { useCore } from "@notefig/core/react";
import type { LayoutNode } from "@/components/dockable";
import { useLayout } from "@/modules/layout/react";
import type { OpenTabOptions } from "@/modules/tabs";
import { getTabSelectedText, setActiveTab } from "@/modules/tabs/tab-controllers";
import type { FileTreeNode } from "@/utils/fs";

export interface UseDockableTabsOptions {
  /** Scopes the tab hotkeys to the dock. */
  dockableRef?: RefObject<HTMLElement | null>;
}

export interface UseDockableTabsResult {
  layout: LayoutNode[];

  openTabs: string[];

  activeTabId: string | null;

  /** Open a tree entry as a tab. Returns whether it did: directories and
   *  files the editor cannot open are refused, and a caller that grants
   *  something on the strength of the open (a focus hand-off) must know. */
  handleFileSelect: (file: FileTreeNode, options?: OpenTabOptions) => boolean;

  /** The dock's onChange: takes its layout, disposing removed tabs. */
  handleLayoutChange: (newLayout: LayoutNode[]) => void;

  closeActiveTab: () => void;

  getFocusedTabId: () => string | null;

  /** Focus the active tab's own surface — whatever kind of tab it is. */
  focusActiveTab: () => boolean;

  /** Text selected inside the active tab, if any. */
  getSelectedText: () => string | undefined;
}

/**
 * The dock's React half: re-renders on layout and focused-window changes,
 * keeps the focus arbiter pointed at the active tab, and binds the tab
 * hotkeys. Every change to tabs goes through `core.tabs`; what each tab
 * *renders* is `modules/tabs/tab-types.tsx`.
 */
export function useDockableTabs(
  options: UseDockableTabsOptions = {},
): UseDockableTabsResult {
  const { dockableRef } = options;
  const { tabs } = useCore();
  const { layout, openTabs } = useLayout();
  const activeTabId = useSyncExternalStore(
    tabs.subscribe,
    tabs.activeTabId,
    tabs.activeTabId,
  );

  useEffect(() => {
    setActiveTab(activeTabId);
  }, [activeTabId]);

  // Every layout change re-asks for focus on the active tab; the request
  // waits for the tab to mount and loses to modals and live text entry.
  useEffect(() => {
    const tabId = tabs.activeTabId();
    if (!tabId) return;
    tabs.focus(tabId, { when: "when-mounted", reason: "tab-selected" });
  }, [tabs, layout]);

  const handleFileSelect = useCallback(
    (file: FileTreeNode, openOptions?: OpenTabOptions): boolean => {
      if (file.type !== "file") return false;
      const opened = tabs.open(file.path, openOptions);
      if (!opened) console.warn(`File cannot be opened as tab: ${file.path}`);
      return opened;
    },
    [tabs],
  );

  const handleLayoutChange = useCallback(
    (newLayout: LayoutNode[]) => tabs.applyLayout(newLayout),
    [tabs],
  );

  const getFocusedTabId = useCallback(() => tabs.activeTabId(), [tabs]);

  const closeActiveTab = useCallback(() => {
    const tabId = tabs.activeTabId();
    if (tabId) tabs.close(tabId);
  }, [tabs]);

  const focusActiveTab = useCallback(() => {
    const tabId = tabs.activeTabId();
    return tabId ? tabs.focus(tabId) : false;
  }, [tabs]);

  const getSelectedText = useCallback(() => {
    const tabId = tabs.activeTabId();
    return tabId ? getTabSelectedText(tabId) : undefined;
  }, [tabs]);

  const selectTabAtIndex = useCallback(
    (index: number) => {
      const tabId = tabs.activeWindowTabs()[index];
      if (tabId) tabs.select(tabId);
    },
    [tabs],
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

  /** Move the selection `offset` tabs along the active window, wrapping. */
  const selectTabByOffset = useCallback(
    (offset: number) => {
      const windowTabs = tabs.activeWindowTabs();
      if (windowTabs.length <= 1) return;
      const currentIndex = windowTabs.indexOf(tabs.activeTabId() ?? "");
      if (currentIndex === -1) return;
      const count = windowTabs.length;
      tabs.select(windowTabs[(currentIndex + offset + count) % count]);
    },
    [tabs],
  );

  const selectNextTab = useCallback(
    () => selectTabByOffset(1),
    [selectTabByOffset],
  );

  const selectPrevTab = useCallback(
    () => selectTabByOffset(-1),
    [selectTabByOffset],
  );

  return {
    layout,
    openTabs,
    activeTabId,
    handleFileSelect,
    handleLayoutChange,
    closeActiveTab,
    getFocusedTabId,
    focusActiveTab,
    getSelectedText,
  };
}
