/**
 * Platform type enum
 */
export enum Platform {
  TAURI = "tauri",
  BROWSER = "browser",
}

/**
 * Detects the current platform at runtime
 * Uses multiple detection strategies for reliability:
 * 1. Check for Tauri internals object (most reliable in Tauri v2)
 * 2. Check for __TAURI__ object (legacy detection)
 * 3. Check if we're in a browser context without Tauri
 */
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

  // Default to browser environment
  return Platform.BROWSER;
}

// Detect platform once at module load time
let _platform: Platform | null = null;

/**
 * Gets the current platform (cached after first detection)
 */
export function getPlatform(): Platform {
  if (_platform === null) {
    _platform = detectPlatform();
    console.log(`[Platform] Detected platform: ${_platform}`);
  }
  return _platform;
}

/**
 * Detects if the application is running in a Tauri environment
 */
export function isTauri(): boolean {
  return getPlatform() === Platform.TAURI;
}

/**
 * Detects if running in a browser/web environment (non-Tauri)
 */
export function isWeb(): boolean {
  return getPlatform() === Platform.BROWSER;
}
