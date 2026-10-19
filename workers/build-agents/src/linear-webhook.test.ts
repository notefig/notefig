import { describe, expect, it } from "vitest";
import { readConfig, type Env } from "./config.ts";
import { readLinearWebhook } from "./linear-webhook.ts";
import { env } from "cloudflare:workers";
import { sign } from "../test/sign.ts";

const SECRET = "linear-webhook-secret";
const NOW = Date.parse("2026-10-19T12:00:00Z");
const config = readConfig(env as unknown as Env);

function event(overrides: Record<string, unknown> = {}) {
	return {
		type: "AgentSessionEvent",
		action: "created",
		webhookTimestamp: NOW,
		promptContext: "<issue>…</issue>",
		agentSession: { id: "session-1", issue: { id: "issue-1" }, creator: { email: "Approver@example.com" } },
		...overrides,
	};
}

async function read(body: unknown, signature?: string | null) {
	const raw = JSON.stringify(body);
	return readLinearWebhook(raw, signature === undefined ? await sign(SECRET, raw) : signature, SECRET, config, NOW);
}

describe("readLinearWebhook", () => {
	it("starts an agent when an approver delegates an issue", async () => {
		expect(await read(event())).toEqual({
			ok: true,
			command: { kind: "start", issueId: "issue-1", sessionId: "session-1", prompt: "<issue>…</issue>" },
		});
	});

	it("ignores a delegation by anyone else", async () => {
		const outcome = await read(event({ agentSession: { id: "s", issue: { id: "i" }, creator: { email: "stranger@example.com" } } }));
		expect(outcome).toMatchObject({ ok: true, command: undefined });
	});

	it("steers with an approver's message and stops on the stop signal", async () => {
		const prompted = (activity: Record<string, unknown>) =>
			event({ action: "prompted", agentActivity: { id: "activity-1", user: { email: "approver@example.com" }, ...activity } });
		expect(await read(prompted({ content: { body: "Use the existing helper" } }))).toEqual({
			ok: true,
			command: { kind: "steer", issueId: "issue-1", sessionId: "session-1", text: "Use the existing helper", requestId: "linear:activity-1" },
		});
		expect(await read(prompted({ signal: "stop" }))).toEqual({
			ok: true,
			command: { kind: "stop", issueId: "issue-1", sessionId: "session-1" },
		});
	});

	it("reports an issue's delegate being removed or changed, and nothing else about issues", async () => {
		const issue = (data: Record<string, unknown>, updatedFrom: Record<string, unknown>) => ({
			type: "Issue",
			action: "update",
			webhookTimestamp: NOW,
			data: { id: "issue-1", ...data },
			updatedFrom,
		});
		expect(await read(issue({ delegateId: null }, { delegateId: "app-user" }))).toEqual({
			ok: true,
			command: { kind: "undelegated", issueId: "issue-1", previousDelegateId: "app-user" },
		});
		expect(await read(issue({ delegateId: "other-agent" }, { delegateId: "app-user" }))).toMatchObject({
			command: { kind: "undelegated", previousDelegateId: "app-user" },
		});
		expect(await read(issue({ delegateId: "app-user" }, { title: "old" }))).toMatchObject({ ok: true, command: undefined });
	});

	it("refuses a session without an id", async () => {
		expect(await read(event({ agentSession: { id: "", issue: { id: "i" }, creator: { email: "approver@example.com" } } }))).toMatchObject({
			ok: false,
			status: 400,
		});
	});

	it("refuses unsigned, wrongly signed and stale deliveries", async () => {
		expect(await read(event(), null)).toMatchObject({ ok: false, status: 401 });
		expect(await read(event(), "zz")).toMatchObject({ ok: false, status: 401 });
		expect(await read(event({ webhookTimestamp: NOW - 61_000 }))).toMatchObject({ ok: false, status: 401 });
	});
});
