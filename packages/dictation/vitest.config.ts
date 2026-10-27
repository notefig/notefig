import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The service follows keys on `window`; the mic's resampler is pure.
    environment: "happy-dom",
    include: ["src/**/*.test.ts"],
  },
});
