export enum Platform {
  TAURI = "tauri",
  BROWSER = "browser",
}

function detectPlatform(): Platform {
  if (typeof window === "undefined") {
    // Server-side rendering context (shouldn't happen in this app)
    return Platform.BROWSER;
  }

  // Check for Tauri v2 internals (most reliable)
  if ("__TAURI_INTERNALS__" in window) {
    return Platform.TAURI;
  }

  // Check for legacy __TAURI__ object
  if ("__TAURI__" in window) {
    return Platform.TAURI;
  }

  // Try to detect by checking if Tauri API is available
  try {
    // In Tauri, the window object will have these injected
    const windowAny = window as any;
    if (windowAny.__TAURI_INTERNALS__ !== undefined) {
      return Platform.TAURI;
    }
  } catch (error) {
    // If we get an error, we're likely in a browser
  }

  return Platform.BROWSER;
}

let _platform: Platform | null = null;

export function getPlatform(): Platform {
  if (_platform === null) {
    _platform = detectPlatform();
    console.log(`[Platform] Detected platform: ${_platform}`);
  }
  return _platform;
}

export function isTauri(): boolean {
  return getPlatform() === Platform.TAURI;
}

export function isWeb(): boolean {
  return getPlatform() === Platform.BROWSER;
}
