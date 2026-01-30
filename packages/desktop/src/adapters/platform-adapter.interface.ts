import type { Theme } from "@/components/theme-provider";

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
  pickDirectory(title?: string): Promise<string | null>;

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
}
