import { defineConfig } from "vitest/config";
import path from "path";
import pkg from "./package.json";

export default defineConfig({
  define: {
    // Mirror vite.config.ts — telemetry stamps app_version on every event.
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  test: {
    environment: "happy-dom",
    globals: true,
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["tests/e2e/**", "**/node_modules/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
    },
    server: {
      deps: {
        // Externalized deps resolve react via Node and can grab the hoisted
        // root copy; inlining routes them through Vite so dedupe applies.
        inline: ["@tanstack/react-db", "@tanstack/db"],
      },
    },
  },
  resolve: {
    // Mirror vite.config.ts: resolve @metrists/shared to its TS source so
    // tests compile the same code the app bundles (no CJS star-re-export
    // named-export gaps, no stale-dist drift).
    alias: [
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
    // Hoisted deps (e.g. @tanstack/react-db at the repo root) must not pull
    // in a second React copy — hooks break across instances.
    dedupe: ["react", "react-dom"],
  },
});
