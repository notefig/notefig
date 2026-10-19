import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Runs in workerd, against test/wrangler.jsonc: the real config without the container, which needs Docker.
export default defineConfig({
	plugins: [cloudflareTest({ wrangler: { configPath: fileURLToPath(new URL("./test/wrangler.jsonc", import.meta.url)) } })],
	test: { include: ["src/**/*.test.ts", "test/**/*.test.ts"] },
});
