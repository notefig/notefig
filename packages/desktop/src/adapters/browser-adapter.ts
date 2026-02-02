import { Store } from "tinybase";
import type { IPlatformAdapter } from "./platform-adapter.interface";
import type { Theme } from "@/components/theme-provider";
import {
  type PersistedChanges,
  type PersistedContent,
  type Persister,
  createCustomPersister,
} from "tinybase/persisters";
import { IndexedDBStorage } from "@/utils/indexdb-storage";
import { generateDemoFiles } from "@/utils/demo-data";

/**
 * Browser platform adapter
 * Implements platform-specific operations for browser/web environment
 */
export class BrowserPlatformAdapter implements IPlatformAdapter {
  protected persister: Persister | undefined;
  protected currentBasePath: string | null = null;
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

  getPersister(store: Store, basePath: string): Persister {
    // Reset persister if basePath changed
    if (this.currentBasePath !== null && this.currentBasePath !== basePath) {
      console.log(`[BrowserAdapter] Base path changed, resetting persister`);
      this.persister = undefined;
      this.currentBasePath = null;
    }

    if (this.persister) {
      return this.persister;
    }

    this.currentBasePath = basePath;
    const storage = new IndexedDBStorage(basePath);

    this.persister = createCustomPersister(
      store,
      // getPersisted - Load from IndexedDB
      async (): Promise<PersistedContent | undefined> => {
        try {
          console.log(
            `[BrowserAdapter] Loading workspace from IndexedDB: ${basePath}`,
          );

          await storage.initialize();

          const hasData = await storage.hasData();

          if (!hasData) {
            // First time loading this workspace - populate with demo data
            console.log(
              "[BrowserAdapter] No existing data found, creating demo workspace",
            );
            const demoFiles = generateDemoFiles();
            await storage.saveAllFiles(demoFiles);
          }

          // Load all files from IndexedDB
          const files = await storage.loadAllFiles();

          // Return in TinyBase format: [tables, values]
          // tables = { files: Record<path, FileRowData> }
          // values = {} (empty for now)
          // Cast to any to avoid type issues with optional fields
          return [{ files: files as any }, {}];
        } catch (error) {
          console.error(
            "[BrowserAdapter] Failed to load from IndexedDB:",
            error,
          );
          return undefined;
        }
      },
      // setPersisted - Save changes to IndexedDB (no-op for now)
      async (
        _getContent: () => PersistedContent,
        _changes?: PersistedChanges,
      ) => {
        // TODO: Implement incremental saves later
        console.log("[BrowserAdapter] Save requested (not yet implemented)");
      },
      // addPersisterListener - Listen for changes (no-op in browser)
      (_listener) => {
        // No file watching in browser
        return () => {};
      },
      // delPersisterListener - Clean up listener (no-op in browser)
      () => {},
    );

    return this.persister;
  }
}
