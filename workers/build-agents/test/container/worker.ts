import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createEnvConformance, type EnvConformanceAssertions } from "@earendil-works/pi-durable/testing";
import { ContainerEnv } from "../../src/container-env.ts";

/**
 * Runs Pi's environment conformance suite against `ContainerEnv` in this object's container, one case at a time,
 * each in a fresh directory. `GET /` answers with every case's outcome.
 */
export class ConformanceHarness extends DurableObject {
	/** What IssueAgent relies on to resume a workspace: a snapshot restores the container's files, and idling is set. */
	async snapshot(): Promise<{ name: string; ok: boolean; error?: string; ms: number }[]> {
		const started = Date.now();
		const container = this.ctx.container;
		if (!container) throw new Error("No container binding");
		const env = new ContainerEnv(container, { id: "snapshot", cwd: "/" });
		const until = async () => {
			for (let attempt = 0; attempt < 60; attempt++) {
				if ((await env.exec(["true"], undefined, BACKGROUND_CONTEXT).catch(() => undefined))?.ok) return;
				await new Promise((resolve) => setTimeout(resolve, 1000));
			}
			throw new Error("The container did not start");
		};
		try {
			container.start({ image: container.images.harness, enableInternet: false });
			await until();
			await container.setInactivityTimeout(10 * 60_000);
			const written = await env.writeFile("/workspace/repo/kept.txt", "kept", BACKGROUND_CONTEXT);
			if (!written.ok) throw written.error;
			const snapshot = await container.snapshotContainer({ name: "harness" });
			await container.destroy();
			container.start({ containerSnapshot: { id: snapshot.id }, enableInternet: false });
			await until();
			const read = await env.readTextFile("/workspace/repo/kept.txt", BACKGROUND_CONTEXT);
			if (!read.ok || read.value !== "kept") throw new Error(`After restore: ${read.ok ? read.value : read.error.message}`);
			return [{ name: "a container snapshot restores its files", ok: true, ms: Date.now() - started }];
		} catch (error) {
			return [{ name: "a container snapshot restores its files", ok: false, error: error instanceof Error ? error.message : String(error), ms: Date.now() - started }];
		}
	}

	async run(only?: string): Promise<{ name: string; ok: boolean; error?: string; ms: number }[]> {
		const container = this.ctx.container;
		if (!container) throw new Error("No container binding");
		if (!container.running) container.start({ image: container.images.harness, enableInternet: false });
		const probe = new ContainerEnv(container, { id: "harness", cwd: "/" });
		for (let attempt = 0; ; attempt++) {
			if ((await probe.exec(["true"], undefined, BACKGROUND_CONTEXT).catch(() => undefined))?.ok) break;
			if (attempt > 60) throw new Error("The container did not start");
			await new Promise((resolve) => setTimeout(resolve, 1000));
		}

		let directory = 0;
		const cases = createEnvConformance({
			assertions,
			withEnv: async (use) => {
				const cwd = `/tmp/case-${++directory}`;
				await probe.exec(["mkdir", "-p", cwd], undefined, BACKGROUND_CONTEXT);
				const env = new ContainerEnv(container, { id: `case-${directory}`, cwd });
				try {
					await use(env);
				} finally {
					await env.cleanup();
					await probe.exec(["rm", "-rf", cwd], undefined, BACKGROUND_CONTEXT);
				}
			},
			// listFiles is optional in Pi, which walks directories itself without it; ContainerEnv leaves it out.
			listFiles: false,
		});
		// ContainerEnv's own cases, beyond Pi's suite.
		const ownCases = [
			{
				name: "a program exiting 211 keeps its exit status, and a missing one is a spawn error",
				run: async () => {
					const env = new ContainerEnv(container, { id: "own-exit", cwd: "/tmp" });
					const exited = await env.exec(["sh", "-c", "exit 211"], undefined, BACKGROUND_CONTEXT);
					assertions.ok(exited.ok && exited.value.exitCode === 211, `exit 211 → ${JSON.stringify(exited)}`);
					const missing = await env.exec(["no-such-program-here"], undefined, BACKGROUND_CONTEXT);
					assertions.ok(!missing.ok && missing.error.code === "spawn_error", "missing → spawn_error");
				},
			},
			{
				name: "a command without a timeout gets the environment's default",
				run: async () => {
					const env = new ContainerEnv(container, { id: "own-timeout", cwd: "/tmp", defaultTimeoutSeconds: 1 });
					const started = Date.now();
					const result = await env.exec(["sleep", "30"], undefined, BACKGROUND_CONTEXT);
					assertions.ok(!result.ok && result.error.code === "timeout", `sleep 30 → ${JSON.stringify(result)}`);
					assertions.ok(Date.now() - started < 10_000, "ended near the default, not after the command");
				},
			},
			{
				name: "cleanup stops open watchers' polling",
				run: async () => {
					const env = new ContainerEnv(container, { id: "own-watch", cwd: "/tmp" });
					await env.writeFile("/tmp/own-watch/file", "one", BACKGROUND_CONTEXT);
					const changes: unknown[] = [];
					const watcher = await env.watch([{ path: "/tmp/own-watch", recursive: true }], (change) => changes.push(change), BACKGROUND_CONTEXT);
					assertions.ok(watcher.ok, "watch started");
					await env.cleanup();
					await env.writeFile("/tmp/own-watch/file", "two!", BACKGROUND_CONTEXT);
					await new Promise((resolve) => setTimeout(resolve, 1000));
					assertions.strictEqual(changes.length, 0);
				},
			},
		];
		const results = [];
		for (const testCase of [...cases, ...ownCases] as { name: string; timeoutMs?: number; run(): Promise<void> }[]) {
			if (only && !testCase.name.includes(only)) continue;
			const started = Date.now();
			try {
				await Promise.race([
					testCase.run(),
					new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), testCase.timeoutMs ?? 20_000)),
				]);
				results.push({ name: testCase.name, ok: true, ms: Date.now() - started });
			} catch (error) {
				results.push({ name: testCase.name, ok: false, error: error instanceof Error ? error.message : String(error), ms: Date.now() - started });
			}
		}
		return results;
	}
}

export default {
	async fetch(request: Request, env: { HARNESS: DurableObjectNamespace<ConformanceHarness> }) {
		const url = new URL(request.url);
		if (url.pathname === "/snapshot") return Response.json(await env.HARNESS.getByName(`snapshot-${Date.now()}`).snapshot());
		const only = url.searchParams.get("only") ?? undefined;
		return Response.json(await env.HARNESS.getByName("conformance").run(only));
	},
};

/** The suite's assertions, without a test runner. */
const assertions: EnvConformanceAssertions = {
	ok(value, message) {
		if (!value) throw new Error(message ?? `Expected a truthy value, got ${show(value)}`);
	},
	strictEqual(actual, expected) {
		if (!Object.is(actual, expected)) throw new Error(`Expected ${show(expected)}, got ${show(actual)}`);
	},
	deepEqual(actual, expected) {
		if (!equal(actual, expected, false)) throw new Error(`Expected ${show(expected)}, got ${show(actual)}`);
	},
	partialDeepEqual(actual, expected) {
		if (!equal(actual, expected, true)) throw new Error(`Expected to include ${show(expected)}, got ${show(actual)}`);
	},
	greaterThan(actual, expected) {
		if (!(actual > expected)) throw new Error(`Expected more than ${expected}, got ${actual}`);
	},
	async rejects(operation, messageIncludes) {
		try {
			await operation;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!message.includes(messageIncludes)) throw new Error(`Rejected with "${message}", expected "${messageIncludes}"`);
			return;
		}
		throw new Error(`Expected a rejection including "${messageIncludes}"`);
	},
};

function equal(actual: unknown, expected: unknown, partial: boolean): boolean {
	if (Object.is(actual, expected)) return true;
	if (actual instanceof Uint8Array && expected instanceof Uint8Array) {
		return actual.length === expected.length && actual.every((byte, index) => byte === expected[index]);
	}
	if (typeof actual !== "object" || typeof expected !== "object" || actual === null || expected === null) return false;
	if (Array.isArray(expected)) {
		return Array.isArray(actual) && actual.length === expected.length && expected.every((item, index) => equal(actual[index], item, partial));
	}
	const keys = Object.keys(expected);
	if (!partial && Object.keys(actual).length !== keys.length) return false;
	return keys.every((key) => equal((actual as Record<string, unknown>)[key], (expected as Record<string, unknown>)[key], partial));
}

function show(value: unknown): string {
	try {
		return JSON.stringify(value, (_key, item) => (item instanceof Uint8Array ? `bytes(${item.length})` : item))?.slice(0, 300) ?? String(value);
	} catch {
		return String(value);
	}
}
