import type { IPlatformAdapter } from "./platform-adapter.interface";
import { TauriPlatformAdapter } from "./tauri-adapter";
import { BrowserPlatformAdapter } from "./browser-adapter";
import {
  BrowserFsPlatformAdapter,
  shouldUseBrowserFsAdapter,
} from "./browser-fs-adapter";
import { Platform, getPlatform } from "@/utils/platform";

class PlatformAdapterFactory {
  private static instance: IPlatformAdapter | null = null;

  static getInstance(): IPlatformAdapter {
    if (!this.instance) {
      const platform = getPlatform();

      switch (platform) {
        case Platform.TAURI:
          this.instance = new TauriPlatformAdapter();
          break;
        case Platform.BROWSER:
          this.instance = shouldUseBrowserFsAdapter()
            ? new BrowserFsPlatformAdapter()
            : new BrowserPlatformAdapter();
          break;
        default:
          this.instance = new BrowserPlatformAdapter();
      }
    }

    return this.instance!;
  }

  /** Resets the singleton instance (mainly for testing). */
  static reset(): void {
    this.instance = null;
  }
}

export const platformAdapter = PlatformAdapterFactory.getInstance();

export { PlatformAdapterFactory };

export type { IPlatformAdapter } from "./platform-adapter.interface";
