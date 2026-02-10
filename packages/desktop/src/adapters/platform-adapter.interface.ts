import type { Theme } from "@/components/theme-provider";
import type { Store } from "tinybase";
import type { Persister } from "tinybase/persisters";

/**
 * Platform events that can be emitted
 */
export type PlatformEvent =
  | { type: "theme-changed"; payload: Theme }
  | { type: "folder-selected"; payload: string }
  | { type: "file-dropped"; payload: string[] };

/**
 * Generic event listener callback
 */
export type PlatformEventListener = (event: PlatformEvent) => void;

/**
 * Platform adapter interface
 * Provides a unified interface for platform-specific operations
 * (Tauri vs Browser)
 */
export interface IPlatformAdapter {
  /**
   * Opens a directory picker dialog
   * @param title - Optional title for the picker dialog
   * @returns Promise that resolves to the selected directory path or null if cancelled
   */
  pickDirectory(title: string): Promise<string | null>;

  /**
   * Adds a generic platform event listener
   * @param callback - Function to call when events are emitted
   * @returns Cleanup function to remove the listener
   */
  addEventListener(callback: PlatformEventListener): () => void;

  /**
   * Removes a platform event listener
   * @param callback - The callback function to remove
   */
  removeEventListener(callback: PlatformEventListener): void;

  getPersister(store: Store, basePath: string): Persister;
}
