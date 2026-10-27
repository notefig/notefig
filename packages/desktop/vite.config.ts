import fs from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import pkg from "./package.json";
import { fetchDictationModel } from "./scripts/fetch-dictation-model.mjs";
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

// The dictation model ships in the bundle (public/dictation/, gitignored).
// Making sure it's there before every dev server and build covers `npm run
// dev`, `tauri dev/build`, the web deploy and the e2e server alike. Kept out
// of vite.shared so the marketing site never carries it.
const dictationModel: Plugin = {
  name: "dictation-model",
  buildStart: () => fetchDictationModel(),
};

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [...sharedBuildPlugins(), dictationModel],

  // The e2e shim boots its own Vite server (playwright.shim.config.ts, and
  // ad-hoc runs with VITE_TEST_BACKEND set) while `tauri dev` may be live.
  // Sharing one deps cache lets a shim server's re-optimization swap the
  // chunks out from under the dev webview — every previously served
  // /.vite/deps URL 404s and the Tauri window goes black until a reload.
  // A separate cache dir makes the two servers invisible to each other.
  cacheDir: process.env.VITE_TEST_BACKEND
    ? "node_modules/.vite-shim"
    : undefined,

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
