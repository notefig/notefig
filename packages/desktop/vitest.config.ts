import { defineConfig } from "vitest/config";
import fs from "fs";
import path from "path";
import pkg from "./package.json";
import { workspaceSourceAliases } from "./vite.shared";

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
        inline: ["@tanstack/react-db", "@tanstack/db", "@shadcn/react"],
      },
    },
  },
  resolve: {
    // Workspace packages resolve to TS source so tests compile the same
    // code the app bundles — the list itself lives in vite.shared.ts
    // (workspaceSourceAliases), one authoritative place. Deliberately NOT
    // sharedResolveAliases: tests keep their own `@` entry and skip the
    // browser-only crypto polyfill alias.
    alias: [
      ...workspaceSourceAliases(__dirname),
      { find: "@", replacement: path.resolve(__dirname, "./src") },
    ],
    // Hoisted deps (e.g. @tanstack/react-db at the repo root) must not pull
    // in a second React copy — hooks break across instances.
    dedupe: ["react", "react-dom"],
  },
});
