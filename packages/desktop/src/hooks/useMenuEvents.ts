import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";

interface MenuEventHooks {
  onFolderSelected?: (path: string) => void;
}

export function useMenuEvents({ onFolderSelected }: MenuEventHooks) {
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    const setupListeners = async () => {
      // Listen for folder selection from the native menu
      unlisten = await listen<string>("folder-selected", (event) => {
        if (onFolderSelected) {
          onFolderSelected(event.payload);
        }
      });
    };

    setupListeners();

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, [onFolderSelected]);
}
