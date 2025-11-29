import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTheme } from "@/components/theme-provider";

interface MenuEventHooks {
  onFolderSelected?: (path: string) => void;
}

export function useMenuEvents({ onFolderSelected }: MenuEventHooks) {
  const { setTheme } = useTheme();

  useEffect(() => {
    let unlistenFolder: (() => void) | undefined;
    let unlistenTheme: (() => void) | undefined;

    const setupListeners = async () => {
      // Listen for folder selection from the native menu
      unlistenFolder = await listen<string>("folder-selected", (event) => {
        if (onFolderSelected) {
          onFolderSelected(event.payload);
        }
      });

      // Listen for theme changes from OS menu
      unlistenTheme = await listen<string>("theme-changed", (event) => {
        const theme = event.payload as "light" | "dark" | "system";
        setTheme(theme);
      });
    };

    setupListeners();

    return () => {
      if (unlistenFolder) {
        unlistenFolder();
      }
      if (unlistenTheme) {
        unlistenTheme();
      }
    };
  }, [onFolderSelected, setTheme]);
}
