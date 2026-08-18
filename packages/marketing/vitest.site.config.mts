import path from "node:path";
import { defineConfig } from "vitest/config";

const desktopDir = path.resolve(__dirname, "../desktop");

// Mirrors ../desktop/vitest.config.ts for the site/ sources (which import
// app modules via the same @ alias). Runs on the workspace-root hoisted
// vitest/happy-dom — see the dependency note in vite.site.config.ts.
export default defineConfig({
  test: {
    environment: "happy-dom",
    globals: true,
    include: ["site/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["**/node_modules/**"],
  },
  resolve: {
    alias: [
      {
        find: /^@notefig\/shared$/,
        replacement: path.resolve(desktopDir, "../shared/src/index.ts"),
      },
      {
        find: /^@notefig\/shared\/(.*)$/,
        replacement: path.resolve(desktopDir, "../shared/src/$1/index.ts"),
      },
      { find: "@", replacement: path.resolve(desktopDir, "./src") },
    ],
    dedupe: ["react", "react-dom"],
  },
});
