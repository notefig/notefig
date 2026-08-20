import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    // Mirror desktop's configs: resolve @notefig/shared to its TS source so
    // tests compile the same code consumers bundle.
    alias: [
      {
        find: /^@notefig\/shared$/,
        replacement: path.resolve(__dirname, "../shared/src/index.ts"),
      },
      {
        find: /^@notefig\/shared\/(.*)$/,
        replacement: path.resolve(__dirname, "../shared/src/$1/index.ts"),
      },
    ],
  },
});
