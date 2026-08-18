import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vite";
import pkg from "./package.json";
import {
  sharedBuildPlugins,
  sharedOptimizeDeps,
  sharedResolveAliases,
  sharedWorkerOptions,
} from "./vite.shared";

// Only the current version's release notes ship in the bundle — older files
// stay in release-notes/ as history but are never read. Missing file (a bump
// before the release workflow writes it) yields the empty-state tab.
const latestReleaseNotesFile = path.resolve(
  __dirname,
  `release-notes/v${pkg.version}.md`,
);
const latestReleaseNotes = fs.existsSync(latestReleaseNotesFile)
  ? fs.readFileSync(latestReleaseNotesFile, "utf8")
  : "";

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: sharedBuildPlugins(),

  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __LATEST_RELEASE_NOTES__: JSON.stringify(latestReleaseNotes),
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // 3. tell vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
  // 3. Custom alias defined in ts.config.json
  resolve: {
    alias: sharedResolveAliases(__dirname),
  },

  worker: sharedWorkerOptions,

  optimizeDeps: sharedOptimizeDeps,
}));
