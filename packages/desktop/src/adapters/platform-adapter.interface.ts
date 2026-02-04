import type { Theme } from "@/components/theme-provider";
import type { Store } from "tinybase";
import type { Persister } from "tinybase/persisters";

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
   * Adds a theme change listener
   * @param callback - Function to call when theme changes
   * @returns Cleanup function to remove the listener
   */
  addThemeListener(callback: (theme: Theme) => void): () => void;

  /**
   * Removes a theme change listener
   * @param callback - The callback function to remove
   */
  removeThemeListener(callback: (theme: Theme) => void): void;

  /**
   * Adds an edit action listener (for menu commands like Select All, Undo, etc.)
   * @param callback - Function to call when an edit action is triggered
   * @returns Cleanup function to remove the listener (optional for browser)
   */
  addEditActionListener?(
    callback: (action: string) => void,
  ): (() => void) | void;

  getPersister(store: Store, basePath: string): Persister;
}
