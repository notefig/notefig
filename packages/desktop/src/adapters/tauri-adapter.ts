import type { IPlatformAdapter } from "./platform-adapter.interface";
import type { Theme } from "@/components/theme-provider";
import { open } from "@tauri-apps/plugin-dialog";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import type { Store } from "tinybase";
import {
  PersistedChanges,
  PersistedContent,
  Persister,
  createCustomPersister,
} from "tinybase/persisters";
import { calculateContentHash } from "@/utils/hash";

/**
 * Tauri platform adapter
 * Implements platform-specific operations for Tauri desktop environment
 */
export class TauriPlatformAdapter implements IPlatformAdapter {
  protected persister: Persister | undefined;

  private themeListeners: Map<(theme: Theme) => void, Promise<UnlistenFn>> =
    new Map();

  private editActionListeners: Map<
    (action: string) => void,
    Promise<UnlistenFn>
  > = new Map();

  /**
   * Opens a native directory picker dialog using Tauri
   */
  async pickDirectory(title: string): Promise<string | null> {
    const result = await open({
      title: title,
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

  /**
   * Adds an edit action listener that listens to Tauri edit-action events
   */
  addEditActionListener(callback: (action: string) => void): () => void {
    const unlistenPromise = listen("edit-action", (event) => {
      const action = event.payload as string;
      callback(action);
    });

    // Store the unlisten promise so we can clean up later
    this.editActionListeners.set(callback, unlistenPromise);

    // Return cleanup function
    return () => {
      const unlistenPromise = this.editActionListeners.get(callback);
      if (unlistenPromise) {
        unlistenPromise.then((unlisten) => unlisten());
        this.editActionListeners.delete(callback);
      }
    };
  }

  getPersister(store: Store, basePath: string) {
    if (this.persister) {
      return this.persister;
    }

    this.persister = createCustomPersister(
      store,
      async (): Promise<PersistedContent | undefined> => {
        try {
          const content = await invoke<{ files: Record<string, any> }>(
            "load_directory_files",
            { basePath: basePath },
          );
          return [content, {}];
        } catch (error) {
          return undefined;
        }
      },
      async (
        getContent: () => PersistedContent,
        _changes?: PersistedChanges,
      ) => {
        try {
          const [tables, _values] = getContent();
          const filesTable = (tables as any).files || {};

          const result = await invoke<{
            saved: number;
            skipped: number;
            deleted: number;
            failed: number;
            errors: string[];
            saved_paths: string[];
          }>("save_files", {
            basePath: basePath,
            files: filesTable,
          });

          console.log(
            `[Persister] Saved: ${result.saved}, Skipped: ${result.skipped}, Deleted: ${result.deleted}, Failed: ${result.failed}`,
          );

          // Update savedContentHash for successfully saved files
          if (result.saved_paths && result.saved_paths.length > 0) {
            store.transaction(() => {
              for (const path of result.saved_paths) {
                const content = store.getCell(
                  "files",
                  path,
                  "content",
                ) as string;
                if (content !== undefined) {
                  // Calculate hash and update savedContentHash
                  const hash = calculateContentHash(content);
                  store.setCell("files", path, "savedContentHash", hash);
                  store.setCell("files", path, "contentHash", hash);
                }
              }
            });
          }

          if (result.failed > 0 && result.errors.length > 0) {
            console.error("[Persister] Save errors:", result.errors);
          }
        } catch (error) {
          console.error("[Persister] Failed to save files:", error);
        }
      },
      // addPersisterListener - Listen for changes
      (_listener) => {
        // TODO: Set up file watcher if needed
        return () => {};
      },
      // delPersisterListener - Clean up listener
      () => {
        // TODO: Clean up file watcher
      },
    );
    return this.persister;
  }
}
