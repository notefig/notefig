import fs from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { transform as esbuildTransform } from "esbuild";
import pkg from "./package.json";

// @pierre/trees ships its shadow-root stylesheet with native CSS nesting,
// which hits WebKit bug 290102 on macOS ≤15.3 (fixed upstream May 2025):
// attribute-change style invalidation segfaults WebContent — blank window.
// Compiling the nesting away removes the StyleRuleNestedDeclarations rules
// WebKit chokes on.
function flattenPierreTreesCss(): Plugin {
  return {
    name: "flatten-pierre-trees-css",
    async transform(code, id) {
      const file = id.split("?")[0].replace(/\\/g, "/");
      if (!file.includes("@pierre/trees/") || !file.endsWith("/style.js")) {
        return null;
      }
      const literal = code.match(/var style_default = ("(?:[^"\\]|\\.)*");/);
      if (!literal) {
        throw new Error(
          "flatten-pierre-trees-css: style_default literal not found in @pierre/trees style.js — package shape changed, re-verify the WebKit 290102 mitigation",
        );
      }
      const css = JSON.parse(literal[1]) as string;
      const { code: flat } = await esbuildTransform(css, {
        loader: "css",
        target: "safari15",
      });
      if (flat.includes("&")) {
        throw new Error(
          "flatten-pierre-trees-css: nesting survived the transform — WebKit 290102 mitigation is not effective",
        );
      }
      return code.replace(literal[1], JSON.stringify(flat));
    },
  };
}

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
  plugins: [react(), tailwindcss(), flattenPierreTreesCss()],

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
    alias: [
      // Resolve @notefig/shared to its TS source. The published dist is
      // CommonJS with `export *` star re-exports, which Vite's browser
      // optimizer (cjs-module-lexer) can't see named exports through — so a
      // value import like `newEventId` fails at runtime. Compiling the source
      // directly gives real named exports and avoids stale-dist drift.
      {
        find: /^@notefig\/shared$/,
        replacement: path.resolve(__dirname, "../shared/src/index.ts"),
      },
      {
        find: /^@notefig\/shared\/(.*)$/,
        replacement: path.resolve(__dirname, "../shared/src/$1/index.ts"),
      },
      { find: "@", replacement: path.resolve(__dirname, "./src") },
      // isomorphic-git's packfile reader calls node's crypto.createHash
      // directly (everything else in it uses a browser-safe sha.js
      // fallback). Without this, Vite stubs `crypto` and any repo with
      // packfiles fails its first packed-object read — the git panel shows
      // "commit history metadata is inconsistent" on every real cloned
      // repo. See src/polyfills/node-crypto.ts.
      {
        find: /^crypto$/,
        replacement: path.resolve(__dirname, "./src/polyfills/node-crypto.ts"),
      },
    ],
  },

  // Module workers (markdown conversion) in dev and build.
  worker: {
    format: "es" as const,
  },

  optimizeDeps: {
    // The SQLite persistence package loads its OPFS worker with
    // `new URL("../assets/opfs-worker-*.js", import.meta.url)`. Pre-bundling
    // rewrites the module into node_modules/.vite/deps/ without copying that
    // sibling asset, so the URL resolves to a path the dev server answers with
    // index.html — the worker parses HTML, dies, and every query fails with
    // "OPFS worker terminated unexpectedly". Excluding it serves the package
    // from its own directory, where the asset actually sits. Dev-only: the
    // production build emits the asset correctly either way.
    // @pierre/trees: pre-bundling bypasses transform hooks, which would skip
    // flattenPierreTreesCss in dev.
    exclude: ["@tanstack/browser-db-sqlite-persistence", "@pierre/trees"],
  },
}));
