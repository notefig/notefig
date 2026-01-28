/**
 * Detects if the application is running in a Tauri environment
 */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI__" in window;
}

/**
 * Detects if running in a browser/web environment (non-Tauri)
 */
export function isWeb(): boolean {
  return !isTauri();
}
