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

export type DesktopOs = "macos" | "windows" | "linux";

/**
 * Which OS the Tauri shell is running on, or null on web. Synchronous by
 * design (UA sniffing) so it can gate first-paint layout decisions — the
 * plugin-os API is async and would flash the wrong chrome.
 */
export function getDesktopOs(): DesktopOs | null {
  // The override is checked before the Tauri gate: test harnesses (the e2e
  // shim) pin the real host OS here — browser UAs in test automation are
  // device fictions (Playwright's "Desktop Chrome" claims Windows on every
  // runner) — and workers (no `window`, no Tauri internals) receive it from
  // the main thread at boot, since nothing else in a worker can know the
  // shell OS. Real webviews (WKWebView/WebView2) report their true OS in
  // the UA.
  const override = (globalThis as unknown as Record<string, unknown>)
    .__NOTEFIG_DESKTOP_OS__;
  if (override === "macos" || override === "windows" || override === "linux") {
    return override;
  }
  if (!isTauri()) return null;
  const ua = navigator.userAgent;
  if (ua.includes("Windows")) return "windows";
  if (ua.includes("Mac")) return "macos";
  return "linux";
}
