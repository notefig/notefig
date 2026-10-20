import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { type Env, readConfig } from "./config.ts";

const base = env as unknown as Env;

describe("readConfig", () => {
	it("is in live mode when LINEAR_TEST_LABEL is empty", () => {
		expect(readConfig({ ...base, LINEAR_TEST_LABEL: "" }).testLabel).toBeUndefined();
		expect(readConfig({ ...base, LINEAR_TEST_LABEL: "  " }).testLabel).toBeUndefined();
	});

	it("is in testing mode while LINEAR_TEST_LABEL names a label", () => {
		expect(readConfig({ ...base, LINEAR_TEST_LABEL: " agent-test " }).testLabel).toBe("agent-test");
	});
});
