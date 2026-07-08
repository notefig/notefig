import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import pkg from "./package.json";

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
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
      // Resolve @metrists/shared to its TS source. The published dist is
      // CommonJS with `export *` star re-exports, which Vite's browser
      // optimizer (cjs-module-lexer) can't see named exports through — so a
      // value import like `newEventId` fails at runtime. Compiling the source
      // directly gives real named exports and avoids stale-dist drift.
      {
        find: /^@metrists\/shared$/,
        replacement: path.resolve(__dirname, "../shared/src/index.ts"),
      },
      {
        find: /^@metrists\/shared\/(.*)$/,
        replacement: path.resolve(__dirname, "../shared/src/$1/index.ts"),
      },
      { find: "@", replacement: path.resolve(__dirname, "./src") },
    ],
  },

  // Module workers (markdown conversion) in dev and build.
  worker: {
    format: "es" as const,
  },
}));
