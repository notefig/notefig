import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the performance SLO suite (tests/perf).
 *
 * What it measures has to be what ships, so unlike the other suites this
 * serves a production build through `vite preview`, against the
 * release-built `test-shim`: the real Rust backend on a real filesystem.
 * Both come from `scripts/perf-build.sh`, in `PERF_BUILD` (default
 * perf-build/); the bundle is built in shim mode, so the test seams stay in.
 *
 * The specs start the shim themselves (tests/perf/shim.ts), so a sample
 * can begin from a fresh backend; only the preview server is a web server
 * here. Never reuses a running one: a stale server from another checkout
 * would measure the wrong code, and here nothing would fail to say so.
 *
 * Ports: shim on 4599 (baked into the build); preview on 1423, the perf
 * suite's own (1420 dev, 1421 shim suite, 1422 e2e).
 */
const UI_PORT = 1423;
const BUILD = process.env.PERF_BUILD ?? "perf-build";

export default defineConfig({
  testDir: "./tests/perf",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // A retry would hide a slow sample behind a fast one.
  retries: 0,
  workers: 1,
  reporter: "list",
  timeout: 10 * 60 * 1000,

  use: {
    baseURL: `http://localhost:${UI_PORT}`,
    trace: "off",
    screenshot: "off",
    video: "off",
  },

  projects: [
    {
      name: "perf",
      testMatch: /perf\/.*\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  webServer: {
    command: `npx vite preview --outDir ${BUILD}/dist --port ${UI_PORT} --strictPort`,
    url: `http://localhost:${UI_PORT}`,
    reuseExistingServer: false,
    timeout: 60 * 1000,
  },
});
