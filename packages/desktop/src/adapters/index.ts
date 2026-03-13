import type { IPlatformAdapter } from "./platform-adapter.interface";
import { TauriPlatformAdapter } from "./tauri-adapter";
import { BrowserPlatformAdapter } from "./browser-adapter";
import { Platform, getPlatform } from "@/utils/platform";

/**
 * Platform adapter factory
 * Creates and caches the appropriate platform adapter based on the runtime environment
 */
class PlatformAdapterFactory {
  private static instance: IPlatformAdapter | null = null;

  /**
   * Gets the singleton platform adapter instance
   */
  static getInstance(): IPlatformAdapter {
    if (!this.instance) {
      const platform = getPlatform();

      switch (platform) {
        case Platform.TAURI:
          this.instance = new TauriPlatformAdapter();
          break;
        case Platform.BROWSER:
          this.instance = new BrowserPlatformAdapter();
          break;
        default:
          // Fallback to browser adapter
          this.instance = new BrowserPlatformAdapter();
      }
    }

    return this.instance!;
  }

  /**
   * Resets the singleton instance (mainly for testing)
   */
  static reset(): void {
    this.instance = null;
  }
}

/**
 * Export singleton instance
 * Use this throughout the application for platform-specific operations
 */
export const platformAdapter = PlatformAdapterFactory.getInstance();

/**
 * Export the factory for advanced use cases
 */
export { PlatformAdapterFactory };

/**
 * Re-export types for convenience
 */
export type { IPlatformAdapter } from "./platform-adapter.interface";
export type { ContextMenuItem } from "./platform-adapter.interface";
