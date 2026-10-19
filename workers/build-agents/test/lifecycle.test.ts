import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Activity } from "../src/linear.ts";
import { ISSUE, type Step, type TestIssueAgent } from "./issue-agent.ts";

/**
 * The agent's life in workerd, with Cloudflare's own Durable Object storage, alarms and eviction, a scripted model,
 * and recorded Linear activities.
 */

type Stub = DurableObjectStub<TestIssueAgent>;

const fresh = (): Stub => env.ISSUE_AGENT.get(env.ISSUE_AGENT.newUniqueId()) as unknown as Stub;

async function prepared(steps: Step[], issue = ISSUE): Promise<Stub> {
	const stub = fresh();
	await runInDurableObject(stub, (agent: TestIssueAgent) => {
		agent.setIssue(issue);
		agent.script(steps);
	});
	return stub;
}

const start = (stub: Stub) =>
	runInDurableObject(stub, (agent: TestIssueAgent) => agent.start({ issueId: ISSUE.id, sessionId: "session-1", prompt: "" }));

const activities = (stub: Stub) => runInDurableObject(stub, (agent: TestIssueAgent) => agent.activities());

/** Polls the object until `check` holds. */
async function eventually<T>(stub: Stub, read: (agent: TestIssueAgent) => T | Promise<T>, check: (value: T) => boolean): Promise<T> {
	for (let attempt = 0; attempt < 300; attempt++) {
		const value = await runInDurableObject(stub, read);
		if (check(value)) return value;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Condition not reached");
}

/** Runs the pending heartbeat, if any, and checks it left no alarm behind: nothing is left to run. */
async function idle(stub: Stub): Promise<void> {
	await runDurableObjectAlarm(stub);
	expect(await runInDurableObject(stub, (agent: TestIssueAgent) => agent.alarmAt())).toBeNull();
}

const responses = (list: Activity[]) => list.filter((activity) => activity.type === "response").map((activity) => "body" in activity && activity.body);

describe("an issue's agent", () => {
	it("says it's reading the issue at once, then answers on its session", async () => {
		const stub = await prepared([{ text: "Fixed the flicker." }]);
		await start(stub);
		const list = await eventually(stub, (agent) => agent.activities(), (value) => responses(value).length > 0);
		expect(list[0]).toEqual({ type: "thought", body: "Reading the issue." });
		expect(responses(list)).toEqual(["Fixed the flicker."]);
		// Idle again: the next heartbeat finds nothing to do and clears itself, so the object can sleep.
		await idle(stub);
	});

	it("moves an accepted issue to In Progress when it starts, and leaves one already further along", async () => {
		const todo = await prepared([{ text: "Done." }], { ...ISSUE, stateType: "unstarted" });
		await start(todo);
		expect(await runInDurableObject(todo, (agent: TestIssueAgent) => agent.moves())).toEqual(["issue-1→state-in-progress"]);

		const started = await prepared([{ text: "Done." }]);
		await start(started);
		expect(await runInDurableObject(started, (agent: TestIssueAgent) => agent.moves())).toEqual([]);
	});

	it("turns down an issue still in Triage, or without the test label", async () => {
		const triage = await prepared([], { ...ISSUE, stateType: "triage" });
		await start(triage);
		expect(responses(await activities(triage))).toEqual(["This issue is still in Triage. Accept it first, then delegate it again."]);

		const unlabelled = await prepared([], { ...ISSUE, labels: ["Bug"] });
		await start(unlabelled);
		expect(responses(await activities(unlabelled))).toEqual([
			'While the agent is in testing it only takes issues labelled "agent-test".',
		]);
		expect(await runInDurableObject(unlabelled, (agent: TestIssueAgent) => agent.modelCalls())).toBe(0);
	});

	it("finishes a turn an eviction cut off, from its heartbeat alarm", async () => {
		const stub = await prepared(["hang", { text: "Recovered and fixed." }]);
		await runInDurableObject(stub, async (agent: TestIssueAgent) => {
			await agent.start({ issueId: ISSUE.id, sessionId: "session-1", prompt: "" });
			await agent.hanging;
			expect(await agent.alarmAt()).not.toBeNull();
		});
		await evictDurableObject(stub);
		expect(await runDurableObjectAlarm(stub)).toBe(true);
		const list = await eventually(stub, (agent) => agent.activities(), (value) => responses(value).length > 0);
		expect(responses(list)).toEqual(["Recovered and fixed."]);
	});

	it("takes a maintainer's message as another run, once per Linear activity", async () => {
		const stub = await prepared([{ text: "First pass." }, { text: "Used the helper." }]);
		await start(stub);
		await eventually(stub, (agent) => agent.activities(), (value) => responses(value).length === 1);
		const steer = { sessionId: "session-1", text: "Use the existing helper", requestId: "linear:activity-7" };
		await runInDurableObject(stub, (agent: TestIssueAgent) => agent.steer(steer));
		// Linear retrying the same delivery must not start a third run.
		await runInDurableObject(stub, (agent: TestIssueAgent) => agent.steer(steer));
		const list = await eventually(stub, (agent) => agent.activities(), (value) => responses(value).length === 2);
		expect(responses(list)).toEqual(["First pass.", "Used the helper."]);
		await idle(stub);
		expect(await runInDurableObject(stub, (agent: TestIssueAgent) => agent.modelCalls())).toBe(2);
	});

	it("asks the maintainer and stops until they answer", async () => {
		const stub = await prepared([{ tool: "ask_maintainer", args: { question: "Should renames keep the scroll position?" } }]);
		await start(stub);
		const list = await eventually(stub, (agent) => agent.activities(), (value) => value.some((activity) => activity.type === "elicitation"));
		expect(list).toContainEqual({ type: "elicitation", body: "Should renames keep the scroll position?" });
		expect(list).toContainEqual({ type: "action", action: "ask_maintainer", parameter: "Should renames keep the scroll position?" });
		await idle(stub);
		// The question ended the run: no model call after it.
		expect(await runInDurableObject(stub, (agent: TestIssueAgent) => agent.modelCalls())).toBe(1);
	});

	it("ends for good when its PR merges or it's unassigned: storage erased, branch unmapped, later events ignored", async () => {
		for (const end of [
			(agent: TestIssueAgent) => agent.closed({ merged: true }),
			(agent: TestIssueAgent) => agent.undelegated(),
		]) {
			const stub = await prepared([{ text: "Done." }]);
			await start(stub);
			await eventually(stub, (agent) => agent.activities(), (value) => responses(value).length > 0);
			expect(await env.BRANCHES.get(ISSUE.branchName)).toBe(ISSUE.id);
			await runInDurableObject(stub, end);
			expect(await env.BRANCHES.get(ISSUE.branchName)).toBeNull();
			expect(await runInDurableObject(stub, (agent: TestIssueAgent) => agent.stored())).toEqual([]);
			expect(await runInDurableObject(stub, (agent: TestIssueAgent) => agent.alarmAt())).toBeNull();
			// A late review or CI failure finds nothing to work on.
			await runInDurableObject(stub, (agent: TestIssueAgent) => agent.feedback({ text: "One more thing", requestId: "github:review:9" }));
			expect(await runInDurableObject(stub, (agent: TestIssueAgent) => agent.stored())).toEqual([]);
		}
	});

	it("stops a running turn from the session's stop button", async () => {
		const stub = await prepared(["hang", { text: "Never sent." }]);
		await runInDurableObject(stub, async (agent: TestIssueAgent) => {
			await agent.start({ issueId: ISSUE.id, sessionId: "session-1", prompt: "" });
			await agent.hanging;
			await agent.stop();
		});
		expect(responses(await activities(stub))).toEqual(["Stopped. Send a message to pick it up again."]);
		await idle(stub);
	});
});
