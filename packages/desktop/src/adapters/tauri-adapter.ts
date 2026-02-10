import type {
  IPlatformAdapter,
  PlatformEventListener,
} from "./platform-adapter.interface";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
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
  protected currentBasePath: string | null = null;

  private eventListeners: Set<PlatformEventListener> = new Set();
  private unlistenFns: Promise<UnlistenFn>[] = [];

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
   * Adds a generic platform event listener
   */
  addEventListener(callback: PlatformEventListener): () => void {
    this.eventListeners.add(callback);

    // Set up listeners if this is the first callback
    if (this.eventListeners.size === 1) {
      this.setupListeners();
    }

    // Return cleanup function
    return () => {
      this.removeEventListener(callback);
    };
  }

  /**
   * Removes a platform event listener
   */
  removeEventListener(callback: PlatformEventListener): void {
    this.eventListeners.delete(callback);

    // Clean up listeners if no more callbacks
    if (this.eventListeners.size === 0) {
      this.cleanupListeners();
    }
  }

  /**
   * Set up Tauri event listeners
   */
  private setupListeners(): void {
    // Listen for theme changes
    const themeUnlisten = listen("theme-changed", (event) => {
      const theme = event.payload as any;
      this.eventListeners.forEach((callback) => {
        callback({ type: "theme-changed", payload: theme });
      });
    });
    this.unlistenFns.push(themeUnlisten);

    // Listen for folder selection
    const folderUnlisten = listen("folder-selected", (event) => {
      const folderPath = event.payload as string;
      this.eventListeners.forEach((callback) => {
        callback({ type: "folder-selected", payload: folderPath });
      });
    });
    this.unlistenFns.push(folderUnlisten);

    //TODO: deal with potential race condition
    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "drop") {
          this.eventListeners.forEach((callback) => {
            callback({
              type: "file-dropped",
              payload: (event.payload as any as { paths: string[] }).paths,
            });
          });
        }
      })
      .then((unlisten) => this.unlistenFns.push(Promise.resolve(unlisten)));
  }

  /**
   * Clean up Tauri event listeners
   */
  private cleanupListeners(): void {
    this.unlistenFns.forEach((unlistenPromise) => {
      unlistenPromise.then((unlisten) => unlisten());
    });
    this.unlistenFns = [];
  }

  getPersister(store: Store, basePath: string) {
    // Reset persister if basePath changed
    if (this.currentBasePath !== null && this.currentBasePath !== basePath) {
      console.log(`[TauriAdapter] Base path changed, resetting persister`);
      this.persister = undefined;
      this.currentBasePath = null;
    }

    if (this.persister) {
      return this.persister;
    }

    this.currentBasePath = basePath;

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
