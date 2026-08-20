// Build fragments shared by the app config (vite.config.ts) and the
// marketing config (vite.marketing.config.ts). Pure data + one plugin — no
// target-specific behavior belongs here.
import path from "node:path";
import type { Plugin, PluginOption } from "vite";
import { transform as esbuildTransform } from "esbuild";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * The plugin stack every build of the app needs. Constructed here — in the
 * package that declares the plugin dependencies — so the marketing package's
 * site config can use them without declaring @vitejs/plugin-react or
 * @tailwindcss/vite itself (the latter's tailwind v4 peer would clash with
 * the Nextra site's tailwind v3).
 */
export function sharedBuildPlugins(): PluginOption[] {
  return [react(), tailwindcss(), flattenPierreTreesCss()];
}

// @pierre/trees ships its shadow-root stylesheet with native CSS nesting,
// which hits WebKit bug 290102 on macOS ≤15.3 (fixed upstream May 2025):
// attribute-change style invalidation segfaults WebContent — blank window.
// Compiling the nesting away removes the StyleRuleNestedDeclarations rules
// WebKit chokes on. (Applied to every build so the two targets can't drift.)
export function flattenPierreTreesCss(): Plugin {
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

export function sharedResolveAliases(dirname: string) {
  return [
    // Resolve @notefig/shared to its TS source. The published dist is
    // CommonJS with `export *` star re-exports, which Vite's browser
    // optimizer (cjs-module-lexer) can't see named exports through — so a
    // value import like `newEventId` fails at runtime. Compiling the source
    // directly gives real named exports and avoids stale-dist drift.
    {
      find: /^@notefig\/shared$/,
      replacement: path.resolve(dirname, "../shared/src/index.ts"),
    },
    {
      find: /^@notefig\/shared\/(.*)$/,
      replacement: path.resolve(dirname, "../shared/src/$1/index.ts"),
    },
    // Same source-resolution treatment for the agent protocol package.
    {
      find: /^@notefig\/agent$/,
      replacement: path.resolve(dirname, "../agent/src/index.ts"),
    },
    // Same source-resolution treatment for the agent protocol package.
    {
      find: /^@notefig\/agent$/,
      replacement: path.resolve(dirname, "../agent/src/index.ts"),
    },
    { find: "@", replacement: path.resolve(dirname, "./src") },
    // isomorphic-git's packfile reader calls node's crypto.createHash
    // directly (everything else in it uses a browser-safe sha.js
    // fallback). Without this, Vite stubs `crypto` and any repo with
    // packfiles fails its first packed-object read — the git panel shows
    // "commit history metadata is inconsistent" on every real cloned
    // repo. See src/polyfills/node-crypto.ts.
    {
      find: /^crypto$/,
      replacement: path.resolve(dirname, "./src/polyfills/node-crypto.ts"),
    },
  ];
}

// Module workers (markdown conversion) in dev and build.
export const sharedWorkerOptions = {
  format: "es" as const,
};

export const sharedOptimizeDeps = {
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
};
