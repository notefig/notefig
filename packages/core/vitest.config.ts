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
    // Hoisted deps must not pull in a second React copy — hooks break across
    // instances.
    dedupe: ["react", "react-dom"],
  },
});
