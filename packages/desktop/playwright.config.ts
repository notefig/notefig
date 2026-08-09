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
  retries: process.env.CI ? 2 : 0,
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
  ],

  webServer: {
    command: "npm run dev",
    url: "http://localhost:1420",
    reuseExistingServer: !process.env.CI,
    timeout: 120 * 1000,
  },
});
