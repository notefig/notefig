import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@notefig/shared/intake": path.resolve(__dirname, "../shared/src/intake/index.ts"),
    },
  },
});
