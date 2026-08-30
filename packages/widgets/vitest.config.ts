import path from "node:path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "happy-dom",
    globals: true,
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
  resolve: {
    // Workspace packages resolve to TS source so tests compile the same code
    // the app bundles — mirroring the desktop config's rationale.
    alias: [
      {
        find: /^@notefig\/shared$/,
        replacement: path.resolve(__dirname, "../shared/src/index.ts"),
      },
      {
        find: /^@notefig\/shared\/(.*)$/,
        replacement: path.resolve(__dirname, "../shared/src/$1/index.ts"),
      },
      {
        find: /^@notefig\/ui\/(.*)$/,
        replacement: path.resolve(__dirname, "../ui/src/$1"),
      },
    ],
    // Hoisted deps must not pull in a second React copy — hooks break across
    // instances.
    dedupe: ["react", "react-dom"],
  },
});
