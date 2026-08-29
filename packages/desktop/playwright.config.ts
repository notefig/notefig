import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright configuration for Metrists E2E tests
 * Tests run against the browser version of the app for cross-platform validation
 *
 * Note: test-results/ and playwright-report/ directories are gitignored.
 * They may be created on test failures but won't be committed.
 */
export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 2,
  workers: process.env.CI ? 1 : undefined,
  reporter: "list",

  use: {
    baseURL: "http://localhost:1422",
    trace: "off",
    screenshot: "off",
    video: "off",
  },

  projects: [
    // Full-app end-to-end suites.
    {
      name: "chromium",
      testMatch: /e2e\/.*\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    // Cheap component-level suites against the /__harness/* routes —
    // real browser, no app bootstrap (see src/test-harness/).
    {
      name: "editor",
      testMatch: /editor\/.*\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    // Agent-chat suites against the in-memory mock harness (VITE_AGENT_MOCK
    // on the shared dev server below; see src/agent/mock-harness.ts).
    {
      name: "agent",
      testMatch: /agent\/.*\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  webServer: {
    // VITE_TELEMETRY_DISABLED keeps the first-run consent dialog from opening
    // over the first workspace route; VITE_AGENT_MOCK serves agent sessions
    // from the in-memory mock harness (inert for every non-agent path).
    //
    // Port 1422 is e2e's own (1420 = your dev server, 1421 = the shim suite).
    // It has to be: with `reuseExistingServer`, sharing 1420 meant a plain
    // `npm run dev` you happened to have open got adopted as the test server
    // — and it carries NEITHER env var, so the consent dialog opened over
    // every workspace route and intercepted the clicks. The suite then
    // passed or failed depending on whether the app was running, which also
    // made the pre-push hook unpushable. A dedicated port means the only
    // server ever reused is one started with these flags.
    command:
      "VITE_TELEMETRY_DISABLED=1 VITE_AGENT_MOCK=1 npm run dev -- --port 1422",
    url: "http://localhost:1422",
    reuseExistingServer: !process.env.CI,
    timeout: 120 * 1000,
  },
});
