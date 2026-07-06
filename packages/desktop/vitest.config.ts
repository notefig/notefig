import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
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
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    // Hoisted deps (e.g. @tanstack/react-db at the repo root) must not pull
    // in a second React copy — hooks break across instances.
    dedupe: ["react", "react-dom"],
  },
});
