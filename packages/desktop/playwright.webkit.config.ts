/**
 * Opt-in WebKit run: `PW_WEBKIT=1 npx playwright test -c playwright.webkit.config.ts <spec>`.
 *
 * The closest available proxy for the app's real WKWebView — and the only
 * engine where Playwright reports a Mac platform, which is what ProseMirror
 * keys `Mod-` off of (Desktop Chrome emulates Win32, so Mod = Ctrl there).
 * prompt-composer-keys.spec.ts asserts the Meta bindings under this config.
 */
import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  use: { baseURL: "http://localhost:1422", trace: "off" },
  projects: [
    { name: "webkit", testMatch: /e2e\/.*\.spec\.ts/, use: { ...devices["Desktop Safari"] } },
  ],
  webServer: {
    command: "VITE_TELEMETRY_DISABLED=1 VITE_AGENT_MOCK=1 npx vite --port 1422 --strictPort",
    url: "http://localhost:1422",
    reuseExistingServer: true,
    timeout: 120000,
  },
});
