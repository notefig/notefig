import { Store } from "tinybase";
import type { IPlatformAdapter } from "./platform-adapter.interface";
import type { Theme } from "@/components/theme-provider";
import {
  type PersistedChanges,
  type PersistedContent,
  type Persister,
  createCustomPersister,
} from "tinybase/persisters";

/**
 * Browser platform adapter
 * Implements platform-specific operations for browser/web environment
 */
export class BrowserPlatformAdapter implements IPlatformAdapter {
  protected persister: Persister | undefined;
  /**
   * Opens a mock directory picker dialog in the browser
   * Dispatches a custom event that the MockDirectoryPickerDialog component listens to
   */
  async pickDirectory(title: string): Promise<string | null> {
    return new Promise((resolve) => {
      // Dispatch custom event that the UI component will listen to
      const event = new CustomEvent("mock-pick-directory", {
        detail: {
          title: title,
          callback: (path: string | null) => resolve(path),
        },
      });
      window.dispatchEvent(event);
    });
  }

  /**
   * Adds a theme change listener (no-op in browser)
   * In browser mode, theme changes are handled by the ThemeProvider component
   * and don't come from external sources like Tauri menu events
   */
  addThemeListener(_callback: (theme: Theme) => void): () => void {
    // No-op in browser - return empty cleanup function
    return () => {
      // Nothing to clean up
    };
  }

  /**
   * Removes a theme change listener (no-op in browser)
   */
  removeThemeListener(_callback: (theme: Theme) => void): void {
    // No-op in browser - theme changes are handled by ThemeProvider
  }

  getPersister(store: Store, basePath: string) {
    if (this.persister) {
      return this.persister;
    }
    this.persister = createCustomPersister(
      store,
      //Get Persisted
      async () => {
        return undefined;
      },
      //Load Persisted
      async (
        getContent: () => PersistedContent,
        changes?: PersistedChanges,
      ) => {},
      () => {},
      () => {},
    );
    return this.persister;
  }
}
