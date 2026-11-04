import { defineConfig, devices } from "@playwright/test";
// The TS app's web build, run with:
//   cd ~/Documents/notefig/packages/desktop && VITE_TELEMETRY_DISABLED=1 VITE_AGENT_MOCK=1 npx vite --port 1420 --strictPort
export default defineConfig({
  testDir: ".",
  reporter: "list",
  timeout: 120000,
  use: { baseURL: "http://localhost:1420", ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 },
});
