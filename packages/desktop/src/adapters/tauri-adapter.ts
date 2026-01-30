import type { IPlatformAdapter } from "./platform-adapter.interface";
import type { Theme } from "@/components/theme-provider";
import { open } from "@tauri-apps/plugin-dialog";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * Tauri platform adapter
 * Implements platform-specific operations for Tauri desktop environment
 */
export class TauriPlatformAdapter implements IPlatformAdapter {
  private themeListeners: Map<
    (theme: Theme) => void,
    Promise<UnlistenFn>
  > = new Map();

  /**
   * Opens a native directory picker dialog using Tauri
   */
  async pickDirectory(title?: string): Promise<string | null> {
    const result = await open({
      title: title || "Select Directory",
      directory: true,
      multiple: false,
    });

    return Array.isArray(result) ? result[0] : result;
  }

  /**
   * Adds a theme change listener that listens to Tauri events
   */
  addThemeListener(callback: (theme: Theme) => void): () => void {
    const unlistenPromise = listen("theme-changed", (event) => {
      const theme = event.payload as Theme;
      callback(theme);
    });

    // Store the unlisten promise so we can clean up later
    this.themeListeners.set(callback, unlistenPromise);

    // Return cleanup function
    return () => {
      this.removeThemeListener(callback);
    };
  }

  /**
   * Removes a theme change listener
   */
  removeThemeListener(callback: (theme: Theme) => void): void {
    const unlistenPromise = this.themeListeners.get(callback);
    if (unlistenPromise) {
      unlistenPromise.then((unlisten) => unlisten());
      this.themeListeners.delete(callback);
    }
  }
}
