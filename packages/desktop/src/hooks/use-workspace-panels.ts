/**
 * The workspace shell's own URL state: which side panel is showing and
 * whether the settings modal is open (`?sidebar`, `?sidebarView`,
 * `?settings`). Like the layout, it lives in the URL so a workspace restores
 * exactly as it was left; unlike the layout it says nothing about tabs,
 * which is why it is its own hook rather than more state in `Workspace`.
 */
import { useCallback, type RefObject } from "react";
import { useSearchParams } from "react-router-dom";
import type { SearchPanelHandle } from "@/components/editor/search-panel";
import { retryOnAnimationFrame } from "@/utils/retry-on-animation-frame";
import { DEFAULT_SETTINGS_SECTION } from "@/components/editor/settings-modal";

export interface WorkspacePanelsOptions {
  searchPanelRef: RefObject<SearchPanelHandle | null>;
  /** Where focus goes when the sidebar closes: back into the active tab. */
  focusActiveTab: () => boolean;
}

export interface WorkspacePanels {
  isSidebarCollapsed: boolean;
  toggleSidebarCollapsed: () => void;
  /** Expand the sidebar if collapsed (file creation lands in the tree). */
  openSidebarIfCollapsed: () => void;
  openSettings: () => void;
  /** Show the search panel and focus its input, seeded with the query. */
  openSearchPanel: (options?: {
    filePattern?: string;
    initialQuery?: string;
  }) => void;
  /** Mod+Shift+A — the agent sessions menu in the left sidebar. */
  openSessionsSidebar: () => void;
}

export function useWorkspacePanels({
  searchPanelRef,
  focusActiveTab,
}: WorkspacePanelsOptions): WorkspacePanels {
  const [searchParams, setUrlSearchParams] = useSearchParams();
  const isSidebarCollapsed = searchParams.get("sidebar") === "collapsed";

  /** Show `view` in the sidebar, expanding it if it was collapsed. */
  const showSidebarView = useCallback(
    (view: "search" | "sessions") => {
      setUrlSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set("sidebarView", view);
          next.delete("sidebar"); // ensure expanded
          return next;
        },
        { replace: true },
      );
    },
    [setUrlSearchParams],
  );

  const toggleSidebarCollapsed = useCallback(() => {
    const isClosing = !isSidebarCollapsed;

    setUrlSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (next.get("sidebar") === "collapsed") {
          next.delete("sidebar");
        } else {
          next.set("sidebar", "collapsed");
          next.delete("sidebarView");
        }
        return next;
      },
      { replace: true },
    );

    if (!isClosing) return;

    // The sidebar is going away — don't leave focus on a control inside it.
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest("[data-sidebar]")) {
      active.blur();
    }
    retryOnAnimationFrame(focusActiveTab);
  }, [isSidebarCollapsed, setUrlSearchParams, focusActiveTab]);

  const openSidebarIfCollapsed = useCallback(() => {
    if (!isSidebarCollapsed) return;

    setUrlSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("sidebar");
        return next;
      },
      { replace: true },
    );
  }, [isSidebarCollapsed, setUrlSearchParams]);

  const openSettings = useCallback(() => {
    setUrlSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("settings", DEFAULT_SETTINGS_SECTION);
        return next;
      },
      { replace: true },
    );
  }, [setUrlSearchParams]);

  const openSearchPanel = useCallback(
    (options?: { filePattern?: string; initialQuery?: string }) => {
      showSidebarView("search");

      // The panel may still be mounting — retry until its input is there.
      retryOnAnimationFrame(() => {
        if (!searchPanelRef.current) return false;
        searchPanelRef.current.focusInput({
          filePattern: options?.filePattern,
          initialQuery: options?.initialQuery,
        });
        return true;
      });
    },
    [showSidebarView, searchPanelRef],
  );

  const openSessionsSidebar = useCallback(
    () => showSidebarView("sessions"),
    [showSidebarView],
  );

  return {
    isSidebarCollapsed,
    toggleSidebarCollapsed,
    openSidebarIfCollapsed,
    openSettings,
    openSearchPanel,
    openSessionsSidebar,
  };
}
