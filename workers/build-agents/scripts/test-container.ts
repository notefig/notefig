/**
 * Pi's environment conformance suite against ContainerEnv, in a real container: starts `wrangler dev` on the harness
 * in test/container (Docker builds its slim image), runs every case, prints the outcome, and fails on any failure.
 *
 *   npm run test:container [-- <name filter>]
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const port = 8799;
const only = process.argv[2];

const dev = spawn("npx", ["wrangler", "dev", "-c", "test/container/wrangler.jsonc", "--port", String(port)], {
	cwd: root,
	stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
const ready = new Promise<void>((resolve, reject) => {
	const read = (chunk: Buffer) => {
		log += chunk.toString();
		if (log.includes("Ready on")) resolve();
		if (/✘|ERROR/.test(log) && !log.includes("Ready on")) reject(new Error(log));
	};
	dev.stdout.on("data", read);
	dev.stderr.on("data", read);
	dev.on("exit", (code) => reject(new Error(`wrangler dev exited (${code}):\n${log}`)));
});

let failed = 0;
try {
	await ready;
	type Outcome = { name: string; ok: boolean; error?: string; ms: number };
	const get = async (path: string) =>
		(await (await fetch(`http://localhost:${port}${path}`, { signal: AbortSignal.timeout(15 * 60_000) })).json()) as Outcome[];
	const results = [...(await get(`/${only ? `?only=${encodeURIComponent(only)}` : ""}`)), ...(only ? [] : await get("/snapshot"))];
	for (const result of results) {
		console.log(`${result.ok ? "✓" : "✗"} ${result.name} (${result.ms} ms)${result.ok ? "" : `\n    ${result.error}`}`);
		if (!result.ok) failed++;
	}
	console.log(`\n${results.length - failed}/${results.length} passed`);
} finally {
	dev.kill("SIGINT");
}
process.exit(failed > 0 ? 1 : 0);
