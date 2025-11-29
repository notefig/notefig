import { useSearchParams, useParams } from "react-router-dom";
import { useMemo, useCallback } from "react";
import { getRelativePathForUrl } from "@/utils/routing";

export interface TabNavigationState {
  tabs: string[]; // Relative paths from base directory
  activeIndex: number;
  basePath: string | null;
}

export interface TabNavigationActions {
  openTab: (absolutePath: string) => void;
  closeTab: (absolutePath: string) => void;
  switchToTab: (index: number) => void;
  switchToTabByPath: (absolutePath: string) => void;
  closeAllTabs: () => void;
  getAbsolutePath: (relativePath: string) => string | null;
  getRelativePath: (absolutePath: string) => string | null;
}

/**
 * Hook to manage tab state via URL query parameters
 * Uses ?tab=path1&tab=path2&active=0 format with relative paths
 */
export function useTabNavigation(): TabNavigationState & TabNavigationActions {
  const [searchParams, setSearchParams] = useSearchParams();
  const { basePath } = useParams();

  // Decode base path from URL
  const decodedBasePath = basePath ? decodeURIComponent(basePath) : null;

  // Parse current tab state from URL
  const tabState = useMemo((): TabNavigationState => {
    const tabs = searchParams.getAll("tab"); // Always returns array
    const activeIndex = Math.max(
      0,
      parseInt(searchParams.get("active") || "0", 10),
    );

    // Clamp active index to valid range
    const clampedActiveIndex =
      tabs.length > 0 ? Math.min(activeIndex, tabs.length - 1) : 0;

    return {
      tabs,
      activeIndex: clampedActiveIndex,
      basePath: decodedBasePath,
    };
  }, [searchParams, decodedBasePath]);

  // Helper to convert relative path to absolute path
  const getAbsolutePath = useCallback(
    (relativePath: string): string | null => {
      if (!decodedBasePath) return null;

      // Ensure proper path joining
      const normalizedBasePath = decodedBasePath.startsWith("/")
        ? decodedBasePath
        : "/" + decodedBasePath;

      return `${normalizedBasePath}/${relativePath}`;
    },
    [decodedBasePath],
  );

  // Helper to convert absolute path to relative path
  const getRelativePath = useCallback(
    (absolutePath: string): string | null => {
      if (!decodedBasePath) return null;

      try {
        return getRelativePathForUrl(decodedBasePath, absolutePath);
      } catch (error) {
        console.error("Failed to get relative path:", error);
        return null;
      }
    },
    [decodedBasePath],
  );

  // Update URL with new tab state
  const updateTabState = useCallback(
    (newTabs: string[], newActiveIndex: number = 0) => {
      const newParams = new URLSearchParams(searchParams);

      // Remove all existing tab params
      newParams.delete("tab");
      newParams.delete("active");

      // Add new tab params
      newTabs.forEach((tab) => newParams.append("tab", tab));

      // Set active index (only if we have tabs)
      if (newTabs.length > 0) {
        const clampedIndex = Math.min(
          Math.max(0, newActiveIndex),
          newTabs.length - 1,
        );
        newParams.set("active", clampedIndex.toString());
      }

      setSearchParams(newParams);
    },
    [searchParams, setSearchParams],
  );

  // Open a new tab (or switch to existing)
  const openTab = useCallback(
    (absolutePath: string) => {
      const relativePath = getRelativePath(absolutePath);
      if (!relativePath) return;

      const currentTabs = [...tabState.tabs];
      const existingIndex = currentTabs.indexOf(relativePath);

      if (existingIndex !== -1) {
        // Tab already exists, just switch to it
        updateTabState(currentTabs, existingIndex);
      } else {
        // Add new tab and make it active
        currentTabs.push(relativePath);
        updateTabState(currentTabs, currentTabs.length - 1);
      }
    },
    [tabState.tabs, getRelativePath, updateTabState],
  );

  // Close a tab by absolute path
  const closeTab = useCallback(
    (absolutePath: string) => {
      const relativePath = getRelativePath(absolutePath);
      if (!relativePath) return;

      const currentTabs = [...tabState.tabs];
      const tabIndex = currentTabs.indexOf(relativePath);

      if (tabIndex === -1) return; // Tab not found

      // Remove the tab
      currentTabs.splice(tabIndex, 1);

      if (currentTabs.length === 0) {
        // No tabs left
        updateTabState([]);
      } else {
        // Adjust active index if needed
        let newActiveIndex = tabState.activeIndex;

        if (tabIndex === tabState.activeIndex) {
          // Closed the active tab, switch to next or previous
          newActiveIndex = Math.min(tabIndex, currentTabs.length - 1);
        } else if (tabIndex < tabState.activeIndex) {
          // Closed a tab before the active one, adjust index
          newActiveIndex = tabState.activeIndex - 1;
        }

        updateTabState(currentTabs, newActiveIndex);
      }
    },
    [tabState.tabs, tabState.activeIndex, getRelativePath, updateTabState],
  );

  // Switch to a tab by index
  const switchToTab = useCallback(
    (index: number) => {
      if (index >= 0 && index < tabState.tabs.length) {
        updateTabState(tabState.tabs, index);
      }
    },
    [tabState.tabs, updateTabState],
  );

  // Switch to a tab by absolute path
  const switchToTabByPath = useCallback(
    (absolutePath: string) => {
      const relativePath = getRelativePath(absolutePath);
      if (!relativePath) return;

      const index = tabState.tabs.indexOf(relativePath);
      if (index !== -1) {
        switchToTab(index);
      }
    },
    [tabState.tabs, getRelativePath, switchToTab],
  );

  // Close all tabs
  const closeAllTabs = useCallback(() => {
    updateTabState([]);
  }, [updateTabState]);

  return {
    ...tabState,
    openTab,
    closeTab,
    switchToTab,
    switchToTabByPath,
    closeAllTabs,
    getAbsolutePath,
    getRelativePath,
  };
}
