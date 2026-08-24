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
    baseURL: "http://localhost:1420",
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
    // from the in-memory mock harness (inert for every non-agent path). Note
    // `reuseExistingServer`: a dev server you already had running carries
    // neither env var, so the guarantee holds for a server Playwright starts
    // (as CI always does) — the agent suite in particular needs the mock, so
    // start your own dev server with VITE_AGENT_MOCK=1 when running it
    // alongside one.
    command: "VITE_TELEMETRY_DISABLED=1 VITE_AGENT_MOCK=1 npm run dev",
    url: "http://localhost:1420",
    reuseExistingServer: !process.env.CI,
    timeout: 120 * 1000,
  },
});
