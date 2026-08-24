import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the real-backend e2e shim (MET-73).
 *
 * Unlike the default config (which runs the app's browser/IndexedDB adapter),
 * this boots a Vite dev server with `VITE_TEST_BACKEND=shim` so the app installs
 * the shim transport and runs the REAL Tauri adapter + `src/entities` against the
 * REAL Rust commands on a REAL temp filesystem — via the `test-shim` binary,
 * which dispatches every registered command through a MockRuntime app. This is
 * the substrate MET-83 builds on.
 *
 * Kept a separate config (not a project in playwright.config.ts) so the existing
 * browser suite is untouched and this only spins up the shim + shim-mode dev
 * server when you run `npm run test:e2e:shim`.
 *
 * Ports: shim HTTP/WS on 4599; shim-mode Vite on 1421 (the default dev server
 * owns 1420 with strictPort).
 */
const SHIM_PORT = 4599;
const UI_PORT = 1421;

export default defineConfig({
  testDir: "./tests/shim",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 2,
  workers: 1,
  reporter: "list",

  use: {
    baseURL: `http://localhost:${UI_PORT}`,
    trace: "off",
    screenshot: "off",
    video: "off",
  },

  projects: [
    {
      name: "shim",
      testMatch: /shim\/.*\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  webServer: [
    {
      // The real Rust backend, over HTTP/WS, on a real filesystem.
      command: `cargo run -p test-shim -- --port ${SHIM_PORT}`,
      cwd: "src-tauri",
      url: `http://127.0.0.1:${SHIM_PORT}/health`,
      reuseExistingServer: !process.env.CI,
      // A cold `cargo run` compiles the whole workspace first; CI prebuilds
      // the shim in its own step, but an uncached runner still needs far
      // more than the old 180s here (both shim legs timed out at 180s).
      timeout: 600 * 1000,
    },
    {
      // The app in shim mode — installs the shim transport (see main.tsx).
      command: `npm run dev -- --port ${UI_PORT}`,
      env: {
        VITE_TEST_BACKEND: "shim",
        VITE_TEST_BACKEND_PORT: String(SHIM_PORT),
        // The shim's real backend runs on THIS machine; the browser's UA is
        // a device fiction (Desktop Chrome claims Windows everywhere), so
        // the app's pathutil flavor is pinned to the actual host OS.
        VITE_TEST_HOST_OS: process.platform,
      },
      url: `http://localhost:${UI_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120 * 1000,
    },
  ],
});
