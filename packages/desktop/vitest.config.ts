import { defineConfig } from "vitest/config";
import fs from "fs";
import path from "path";
import pkg from "./package.json";

const latestReleaseNotesFile = path.resolve(
  __dirname,
  `release-notes/v${pkg.version}.md`,
);

export default defineConfig({
  define: {
    // Mirror vite.config.ts — telemetry stamps app_version on every event.
    __APP_VERSION__: JSON.stringify(pkg.version),
    // Mirror vite.config.ts — the release-notes tab renders this.
    __LATEST_RELEASE_NOTES__: JSON.stringify(
      fs.existsSync(latestReleaseNotesFile)
        ? fs.readFileSync(latestReleaseNotesFile, "utf8")
        : "",
    ),
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
    // Mirror vite.config.ts: resolve @notefig/shared to its TS source so
    // tests compile the same code the app bundles (no CJS star-re-export
    // named-export gaps, no stale-dist drift).
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
    ],
    // Hoisted deps (e.g. @tanstack/react-db at the repo root) must not pull
    // in a second React copy — hooks break across instances.
    dedupe: ["react", "react-dom"],
  },
});
