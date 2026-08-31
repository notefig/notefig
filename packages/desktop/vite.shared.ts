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
  return [react(), tailwindcss(), flattenPierreShadowCss()];
}

// @pierre/trees and @pierre/diffs ship their shadow-root stylesheets with
// native CSS nesting, which hits WebKit bug 290102 on macOS ≤15.3 (fixed
// upstream May 2025): attribute-change style invalidation segfaults
// WebContent — blank window. Compiling the nesting away removes the
// StyleRuleNestedDeclarations rules WebKit chokes on. Both packages inline
// their CSS the same way — a `style_default` string literal in dist/style.js.
// (Applied to every build so the two targets can't drift. @pierre/diffs also
// embeds nested CSS in its edit-mode editor module; nothing imports
// `@pierre/diffs/edit`, so only style.js needs flattening.)
export function flattenPierreShadowCss(): Plugin {
  return {
    name: "flatten-pierre-shadow-css",
    async transform(code, id) {
      const file = id.split("?")[0].replace(/\\/g, "/");
      const isPierreStyle =
        (file.includes("@pierre/trees/") || file.includes("@pierre/diffs/")) &&
        file.endsWith("/style.js");
      if (!isPierreStyle) {
        return null;
      }
      const literal = code.match(/var style_default = ("(?:[^"\\]|\\.)*");/);
      if (!literal) {
        throw new Error(
          `flatten-pierre-shadow-css: style_default literal not found in ${file} — package shape changed, re-verify the WebKit 290102 mitigation`,
        );
      }
      const css = JSON.parse(literal[1]) as string;
      const { code: flat } = await esbuildTransform(css, {
        loader: "css",
        target: "safari15",
      });
      if (flat.includes("&")) {
        throw new Error(
          "flatten-pierre-shadow-css: nesting survived the transform — WebKit 290102 mitigation is not effective",
        );
      }
      return code.replace(literal[1], JSON.stringify(flat));
    },
  };
}

/**
 * Resolve the workspace packages (@notefig/shared, @notefig/agent) to their
 * TS source. The published shared dist is CommonJS with `export *` star
 * re-exports, which Vite's browser optimizer (cjs-module-lexer) can't see
 * named exports through — so a value import like `newEventId` fails at
 * runtime; @notefig/agent ships no dist at all. Compiling the source
 * directly gives real named exports and avoids stale-dist drift. The single
 * authoritative list — vite.config.ts (via sharedResolveAliases) and
 * vitest.config.ts both consume it; only tsconfig's `paths` must be kept in
 * sync by hand.
 */
export function workspaceSourceAliases(dirname: string) {
  return [
    {
      find: /^@notefig\/shared$/,
      replacement: path.resolve(dirname, "../shared/src/index.ts"),
    },
    {
      find: /^@notefig\/shared\/(.*)$/,
      replacement: path.resolve(dirname, "../shared/src/$1/index.ts"),
    },
    {
      find: /^@notefig\/agent$/,
      replacement: path.resolve(dirname, "../agent/src/index.ts"),
    },
    // @notefig/ui and @notefig/widgets are source-only (no dist at all):
    // they ship .tsx, which only a bundler can consume. Subpath imports
    // (@notefig/ui/button) map straight onto the file tree; extensions are
    // left off so the resolver picks .ts or .tsx.
    {
      find: /^@notefig\/ui\/(.*)$/,
      replacement: path.resolve(dirname, "../ui/src/$1"),
    },
    {
      find: /^@notefig\/widgets$/,
      replacement: path.resolve(dirname, "../widgets/src/index.ts"),
    },
    {
      find: /^@notefig\/widgets\/(.*)$/,
      replacement: path.resolve(dirname, "../widgets/src/$1"),
    },
  ];
}

export function sharedResolveAliases(dirname: string) {
  return [
    ...workspaceSourceAliases(dirname),
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
  // @pierre/trees, @pierre/diffs: pre-bundling bypasses transform hooks,
  // which would skip flattenPierreShadowCss in dev.
  exclude: [
    "@tanstack/browser-db-sqlite-persistence",
    "@pierre/trees",
    "@pierre/diffs",
  ],
  // An excluded package's imports are served raw, so its CommonJS-only
  // dependency needs pre-bundling explicitly or its default import breaks
  // in dev ("does not provide an export named 'default'").
  include: ["@pierre/diffs > lru_map"],
};
