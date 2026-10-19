import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Runs in workerd, against test/wrangler.jsonc: the real config without the container, which needs Docker.
export default defineConfig({
	plugins: [cloudflareTest({ wrangler: { configPath: fileURLToPath(new URL("./test/wrangler.jsonc", import.meta.url)) } })],
	// The first request loads the whole Worker, Pi included, which takes seconds on a cold CI runner.
	test: { include: ["src/**/*.test.ts", "test/**/*.test.ts"], testTimeout: 30_000 },
});
