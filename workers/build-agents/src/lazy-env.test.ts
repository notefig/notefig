import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { describe, expect, it } from "vitest";
import { LazyEnv } from "./lazy-env.ts";

const context = BACKGROUND_CONTEXT;

/** A stand-in workspace that counts how often it's opened and checks `this` reaches it. */
function workspace() {
	const opened = { count: 0, cleanedUp: 0 };
	const real = {
		marker: "real",
		async exists(this: { marker: string }, path: string) {
			return { ok: true as const, value: `${this.marker}:${path}` === "real:/workspace/repo" };
		},
		async cleanup() {
			opened.cleanedUp++;
		},
	} as unknown as ExecutionEnv;
	return { opened, open: async () => (opened.count++, real) };
}

describe("LazyEnv", () => {
	it("opens nothing until an operation needs the workspace, then opens it once", async () => {
		const { opened, open } = workspace();
		const env = new LazyEnv(open, { id: "container:1", cwd: "/workspace/repo" });
		expect(env.id).toBe("container:1");
		expect(opened.count).toBe(0);
		expect(await env.exists("/workspace/repo", context)).toEqual({ ok: true, value: true });
		await env.exists("/workspace/repo", context);
		expect(opened.count).toBe(1);
	});

	it("cleans up only a workspace it opened", async () => {
		const { opened, open } = workspace();
		const env = new LazyEnv(open, { id: "container:1", cwd: "/" });
		await env.cleanup(context);
		expect(opened).toEqual({ count: 0, cleanedUp: 0 });
		await env.exists("/", context);
		await env.cleanup(context);
		expect(opened).toEqual({ count: 1, cleanedUp: 1 });
	});

	it("fails the operation with why the workspace didn't start, and tries again next time", async () => {
		let attempts = 0;
		const env = new LazyEnv(
			async () => {
				attempts++;
				throw new Error("No container image is configured");
			},
			{ id: "container:1", cwd: "/" },
		);
		await expect(env.exec("ls", undefined, context)).rejects.toThrow("The workspace couldn't start: No container image is configured");
		await expect(env.exec("ls", undefined, context)).rejects.toThrow();
		expect(attempts).toBe(2);
		await env.cleanup(context);
	});
});
