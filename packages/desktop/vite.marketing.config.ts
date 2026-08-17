import fs from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { transform as esbuildTransform } from "esbuild";
import pkg from "./package.json";

// Same mitigation as vite.config.ts (WebKit bug 290102). Duplicated rather
// than exported from the Tauri config so neither build path can drift into
// depending on the other's file.
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
          "flatten-pierre-trees-css: style_default literal not found in @pierre/trees style.js",
        );
      }
      const css = JSON.parse(literal[1]) as string;
      const { code: flat } = await esbuildTransform(css, {
        loader: "css",
        target: "safari15",
      });
      if (flat.includes("&")) {
        throw new Error(
          "flatten-pierre-trees-css: nesting survived the transform",
        );
      }
      return code.replace(literal[1], JSON.stringify(flat));
    },
  };
}

// The marketing entry is index.marketing.html; Cloudflare Pages needs the
// built file to be dist-marketing/index.html.
function renameMarketingIndex(): Plugin {
  return {
    name: "rename-marketing-index",
    closeBundle() {
      const outDir = path.resolve(__dirname, "dist-marketing");
      const from = path.join(outDir, "index.marketing.html");
      if (fs.existsSync(from)) {
        fs.renameSync(from, path.join(outDir, "index.html"));
      }
    },
  };
}

// The marketing build of the desktop app (MET-141): same source, browser-only
// composition root (src/marketing/main.tsx), seeded IndexedDB workspace,
// static deploy with prerendered routes (scripts/prerender-marketing.mjs).
export default defineConfig(async () => ({
  plugins: [
    react(),
    tailwindcss(),
    flattenPierreTreesCss(),
    renameMarketingIndex(),
  ],

  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    // The release-notes tab is unreachable from marketing routes; an empty
    // string keeps the shared modules compiling without bundling notes.
    __LATEST_RELEASE_NOTES__: JSON.stringify(""),
  },

  build: {
    outDir: "dist-marketing",
    rollupOptions: {
      input: path.resolve(__dirname, "index.marketing.html"),
    },
  },

  publicDir: "public-marketing",

  server: {
    port: 1430,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },

  preview: {
    port: 4180,
    strictPort: true,
  },

  resolve: {
    alias: [
      {
        find: /^@notefig\/shared$/,
        replacement: path.resolve(__dirname, "../shared/src/index.ts"),
      },
      {
        find: /^@notefig\/shared\/(.*)$/,
        replacement: path.resolve(__dirname, "../shared/src/$1/index.ts"),
      },
      { find: "@", replacement: path.resolve(__dirname, "./src") },
      {
        find: /^crypto$/,
        replacement: path.resolve(__dirname, "./src/polyfills/node-crypto.ts"),
      },
    ],
  },

  worker: {
    format: "es" as const,
  },

  optimizeDeps: {
    exclude: ["@tanstack/browser-db-sqlite-persistence", "@pierre/trees"],
  },
}));
