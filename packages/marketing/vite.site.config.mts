import path from "node:path";
import { defineConfig } from "vite";
import desktopPkg from "../desktop/package.json";
import {
  sharedBuildPlugins,
  sharedOptimizeDeps,
  sharedResolveAliases,
  sharedWorkerOptions,
} from "../desktop/vite.shared";

const desktopDir = path.resolve(__dirname, "../desktop");

// The marketing site (MET-141): a browser build of the desktop app, owned by
// this package. `site/` holds only the marketing composition root — every
// app module resolves into ../desktop/src via the shared aliases, so the
// desktop package carries no marketing-specific code.
//
// The Vite plugins come pre-constructed from ../desktop/vite.shared — the
// package that declares them — so this package never depends on
// @tailwindcss/vite (its tailwind v4 peer would clash with the Nextra
// site's tailwind v3). `vite` itself resolves to the workspace-root hoisted
// copy (deterministic via package-lock.json).
export default defineConfig(async () => ({
  root: "site",

  plugins: sharedBuildPlugins(),

  define: {
    __APP_VERSION__: JSON.stringify(desktopPkg.version),
    // The release-notes tab is unreachable from marketing routes; an empty
    // string keeps the shared modules compiling without bundling notes.
    __LATEST_RELEASE_NOTES__: JSON.stringify(""),
  },

  build: {
    outDir: "../dist-site",
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(__dirname, "site/index.html"),
    },
  },

  publicDir: path.resolve(__dirname, "site-public"),

  // Explicit empty PostCSS config: without it, Vite walks up from `site/`
  // and finds this package's postcss.config.mjs — the Nextra site's
  // tailwind v3 pipeline — and runs it over the app's v4 stylesheet.
  css: {
    postcss: { plugins: [] },
  },

  server: {
    port: 1430,
    strictPort: true,
  },

  preview: {
    port: 4180,
    strictPort: true,
  },

  resolve: {
    alias: sharedResolveAliases(desktopDir),
    // react resolves to 19.2.x in two places (nested under desktop, hoisted
    // at root); site modules and desktop modules must land on one copy or
    // hooks break across instances.
    dedupe: ["react", "react-dom"],
  },

  worker: sharedWorkerOptions,

  optimizeDeps: sharedOptimizeDeps,
}));
