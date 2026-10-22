import { describe, expect, it } from "vitest";
import { readConfig, type Env } from "./config.ts";
import { commentForAgent, readLinearWebhook } from "./linear-webhook.ts";
import type { IssueComment } from "./linear.ts";
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

	it("reports an issue marked done, cancelled or deleted, but not one moved to another open state", async () => {
		const issue = (action: string, data: Record<string, unknown>, updatedFrom?: Record<string, unknown>) => ({
			type: "Issue",
			action,
			webhookTimestamp: NOW,
			data: { id: "issue-1", delegateId: "app-user", ...data },
			updatedFrom,
		});
		const ended = (why: string) => ({ ok: true, command: { kind: "ended", issueId: "issue-1", why, delegateId: "app-user" } });
		expect(await read(issue("update", { state: { type: "completed" } }, { stateId: "started" }))).toEqual(ended("completed"));
		expect(await read(issue("update", { state: { type: "canceled" } }, { stateId: "started" }))).toEqual(ended("canceled"));
		expect(await read(issue("update", { trashed: true }, { trashed: null }))).toEqual(ended("deleted"));
		expect(await read(issue("remove", {}))).toEqual(ended("deleted"));
		expect(await read(issue("update", { state: { type: "started" } }, { stateId: "unstarted" }))).toMatchObject({ command: undefined });
		// A closed issue edited later isn't closed again.
		expect(await read(issue("update", { state: { type: "completed" } }, { title: "old" }))).toMatchObject({ command: undefined });
	});

	it("hands on a person's new comment on an issue, and nothing else about comments", async () => {
		const comment = (action: string, data: Record<string, unknown>) => ({ type: "Comment", action, webhookTimestamp: NOW, data: { id: "comment-1", ...data } });
		expect(await read(comment("create", { issueId: "issue-1", userId: "user-1" }))).toEqual({
			ok: true,
			command: { kind: "comment", issueId: "issue-1", commentId: "comment-1" },
		});
		expect(await read(comment("update", { issueId: "issue-1", userId: "user-1" }))).toMatchObject({ ok: true, command: undefined });
		expect(await read(comment("create", { issueId: "issue-1", userId: null }))).toMatchObject({ ok: true, command: undefined });
		expect(await read(comment("create", { projectUpdateId: "update-1", userId: "user-1" }))).toMatchObject({ ok: true, command: undefined });
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

describe("commentForAgent", () => {
	const app = { id: "app-user", url: "https://linear.app/notefig/profiles/notefigbuildagent", displayName: "notefigbuildagent" };
	const comment = (overrides: Partial<IssueComment> = {}): IssueComment => ({
		id: "comment-1",
		body: "Look at the raw markdown",
		author: { name: "Parsa", email: "Approver@example.com" },
		inAgentThread: false,
		issue: { id: "issue-1", delegateId: "app-user" },
		...overrides,
	});

	it("passes an approver's comment on an issue delegated to the agent", () => {
		expect(commentForAgent(comment(), app, config)).toBeUndefined();
	});

	it("leaves out comments that aren't the agent's, or that reach it another way", () => {
		expect(commentForAgent(comment({ issue: { id: "issue-1", delegateId: "someone" } }), app, config)).toBe("issue not delegated to the agent");
		expect(commentForAgent(comment({ author: null }), app, config)).toBe("not from an approver");
		expect(commentForAgent(comment({ author: { name: "S", email: "stranger@example.com" } }), app, config)).toBe("not from an approver");
		expect(commentForAgent(comment({ inAgentThread: true }), app, config)).toBe("in an agent session's thread");
		expect(commentForAgent(comment({ body: `[@notefigbuildagent](${app.url}) why?` }), app, config)).toBe("mentions the agent");
		expect(commentForAgent(comment({ body: "@notefigbuildagent why?" }), app, config)).toBe("mentions the agent");
		expect(commentForAgent(comment({ body: "  " }), app, config)).toBe("empty comment");
	});

	it("passes a comment that only quotes the app's name in code, or names another user", () => {
		expect(commentForAgent(comment({ body: "Drop `@notefigbuildagent` from the string" }), app, config)).toBeUndefined();
		expect(commentForAgent(comment({ body: "```\nconst who = \"@notefigbuildagent\";\n```\nRename this" }), app, config)).toBeUndefined();
		expect(commentForAgent(comment({ body: "Ask @notefigbuildagent2 instead" }), app, config)).toBeUndefined();
	});
});
