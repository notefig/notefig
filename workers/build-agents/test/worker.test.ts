import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { sign } from "./sign.ts";

const worker = exports.default;

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
	return worker.fetch(
		new Request(`https://agents.notefig.com${path}`, { method: "POST", body: JSON.stringify(body), headers }),
	);
}

describe("the Worker", () => {
	it("refuses unsigned webhooks", async () => {
		expect((await post("/v1/linear", {})).status).toBe(401);
		expect((await post("/v1/github", {})).status).toBe(401);
	});

	it("acknowledges signed events it has nothing to do for", async () => {
		const body = { type: "Issue", action: "update", webhookTimestamp: Date.now(), agentSession: { id: "s" } };
		const linear = await post("/v1/linear", body, { "Linear-Signature": await sign("linear-webhook-secret", JSON.stringify(body)) });
		expect(await linear.json()).toMatchObject({ outcome: "ignored" });

		const ping = { zen: "Keep it logically awesome." };
		const github = await post("/v1/github", ping, {
			"X-GitHub-Event": "ping",
			"X-Hub-Signature-256": `sha256=${await sign("github-webhook-secret", JSON.stringify(ping))}`,
		});
		expect(await github.json()).toEqual({ outcome: "ignored" });
	});

	it("answers 404 and 405 elsewhere", async () => {
		expect((await post("/v1/other", {})).status).toBe(404);
		expect((await worker.fetch(new Request("https://agents.notefig.com/v1/linear"))).status).toBe(405);
	});
});
