import { useEffect } from "react";

export interface TabKeyboardShortcutsOptions {
  hasOpenTabs: boolean;
  activeTabIndex: number;
  totalTabs: number;
  onTabSwitch: (index: number) => void;
}

/**
 * Hook to handle keyboard shortcuts for tab navigation
 *
 * Supports:
 * - Ctrl+Tab: Next tab (with wraparound)
 * - Ctrl+Shift+Tab: Previous tab (with wraparound)
 * - Ctrl+1-9: Direct tab access (9 = last tab)
 */
export function useTabKeyboardShortcuts({
  hasOpenTabs,
  activeTabIndex,
  totalTabs,
  onTabSwitch,
}: TabKeyboardShortcutsOptions) {
  useEffect(() => {
    // Don't register shortcuts if no tabs are open
    if (!hasOpenTabs || totalTabs === 0) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      // Check if Ctrl (or Cmd on Mac) is pressed
      const isCtrlOrCmd = event.ctrlKey || event.metaKey;

      if (!isCtrlOrCmd) {
        return;
      }

      // Prevent default browser behavior for our shortcuts
      let shouldPreventDefault = false;

      // Handle Ctrl+Tab and Ctrl+Shift+Tab
      if (event.key === "Tab") {
        shouldPreventDefault = true;

        if (event.shiftKey) {
          // Ctrl+Shift+Tab: Previous tab
          const previousIndex =
            activeTabIndex === 0 ? totalTabs - 1 : activeTabIndex - 1;
          onTabSwitch(previousIndex);
        } else {
          // Ctrl+Tab: Next tab
          const nextIndex =
            activeTabIndex === totalTabs - 1 ? 0 : activeTabIndex + 1;
          onTabSwitch(nextIndex);
        }
      }

      // Handle Ctrl+1-9 for direct tab access
      else if (event.key >= "1" && event.key <= "9") {
        shouldPreventDefault = true;

        const requestedTabNumber = parseInt(event.key, 10);

        if (requestedTabNumber === 9) {
          // Ctrl+9: Go to last tab
          onTabSwitch(totalTabs - 1);
        } else {
          // Ctrl+1-8: Go to specific tab index (1-based to 0-based conversion)
          const targetIndex = requestedTabNumber - 1;

          // Only switch if the tab exists
          if (targetIndex < totalTabs) {
            onTabSwitch(targetIndex);
          }
          // If tab doesn't exist, do nothing (no feedback needed)
        }
      }

      // Prevent default browser behavior for our handled shortcuts
      if (shouldPreventDefault) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    // Register global keyboard event listener
    document.addEventListener("keydown", handleKeyDown, true);

    // Cleanup event listener on unmount
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [hasOpenTabs, activeTabIndex, totalTabs, onTabSwitch]);
}
