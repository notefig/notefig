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

	it("keeps a message that arrives while it's still reading the issue, and acts on it once started", async () => {
		const stub = await prepared([{ text: "Started." }, { text: "Used the helper." }]);
		await runInDurableObject(stub, async (agent: TestIssueAgent) => {
			// Not awaited: the message lands while start() waits on Linear.
			const starting = agent.start({ issueId: ISSUE.id, sessionId: "session-1", prompt: "" });
			await agent.steer({ sessionId: "session-1", text: "Use the existing helper", requestId: "linear:early" });
			await starting;
		});
		await eventually(stub, (agent) => agent.modelCalls(), (calls) => calls === 2);
		expect(await runInDurableObject(stub, (agent: TestIssueAgent) => agent.stored())).not.toContain("pending");
	});

	it("carries on in the new session when an accepted issue is delegated again", async () => {
		const stub = await prepared([{ text: "First pass." }, { text: "Carried on." }]);
		await start(stub);
		await eventually(stub, (agent) => agent.activities(), (value) => responses(value).length === 1);
		await runInDurableObject(stub, (agent: TestIssueAgent) =>
			agent.start({ issueId: ISSUE.id, sessionId: "session-2", prompt: "@agent please also handle folders" }),
		);
		const list = await eventually(stub, (agent) => agent.activities(), (value) => responses(value).length === 2);
		expect(list).toContainEqual({ type: "thought", body: "Picking this up again." });
		expect(await runInDurableObject(stub, (agent: TestIssueAgent) => agent.modelCalls())).toBe(2);
		// The new session's request reached the model.
		expect(await runInDurableObject(stub, (agent: TestIssueAgent) => agent.lastPrompt())).toContain("please also handle folders");
		// Linear retrying the first session's delivery changes nothing: no new run, and the newer prompt stays.
		await runInDurableObject(stub, (agent: TestIssueAgent) => agent.start({ issueId: ISSUE.id, sessionId: "session-1", prompt: "old" }));
		expect(await runInDurableObject(stub, (agent: TestIssueAgent) => agent.storedPrompt())).toContain("please also handle folders");
		expect(await runInDurableObject(stub, (agent: TestIssueAgent) => agent.modelCalls())).toBe(2);
	});

	it("still takes a new session's request when posting to Linear fails, and a retry adds nothing", async () => {
		const stub = await prepared([{ text: "First pass." }, { text: "Carried on." }]);
		await start(stub);
		await eventually(stub, (agent) => agent.activities(), (value) => responses(value).length === 1);
		// Posting to Linear fails for the first attempt of session-2, then works.
		await runInDurableObject(stub, async (agent: TestIssueAgent) => {
			agent.failNextPosts(1);
			await agent.start({ issueId: ISSUE.id, sessionId: "session-2", prompt: "Also handle folders" });
		});
		await runInDurableObject(stub, (agent: TestIssueAgent) => agent.start({ issueId: ISSUE.id, sessionId: "session-2", prompt: "Also handle folders" }));
		await eventually(stub, (agent) => agent.modelCalls(), (calls) => calls === 2);
	});

	it("submits messages a restart left in the start-up queue when it comes back", async () => {
		const stub = await prepared([{ text: "First pass." }, { text: "Used the helper." }]);
		await start(stub);
		await eventually(stub, (agent) => agent.activities(), (value) => responses(value).length === 1);
		await runInDurableObject(stub, (agent: TestIssueAgent) => agent.queue([{ text: "Use the helper", requestId: "linear:queued" }]));
		await evictDurableObject(stub);
		// The new instance drains the queue as it opens.
		await eventually(stub, (agent) => agent.modelCalls(), (calls) => calls === 2);
		expect(await runInDurableObject(stub, (agent: TestIssueAgent) => agent.stored())).not.toContain("pending");
	});

	it("keeps nothing for a delegation it turns down, so later messages for it are dropped", async () => {
		const stub = await prepared([], { ...ISSUE, stateType: "triage" });
		await start(stub);
		await runInDurableObject(stub, (agent: TestIssueAgent) => agent.steer({ sessionId: "session-1", text: "Please", requestId: "linear:x" }));
		const stored = await runInDurableObject(stub, (agent: TestIssueAgent) => agent.stored());
		expect(stored.filter((key) => !key.startsWith("test:"))).toEqual([]);
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

	it("tells the model why the workspace couldn't start, instead of Pi's generic error", async () => {
		const stub = await prepared([{ tool: "bash", args: { command: "npm ci" } }, { text: "Asked for help." }]);
		await start(stub);
		await eventually(stub, (agent) => agent.modelCalls(), (calls) => calls === 2);
		const result = await runInDurableObject(stub, (agent: TestIssueAgent) => agent.lastToolResult());
		expect(result).toContain("The workspace couldn't start: No workspace in tests");
		expect(result).not.toContain("No execution environment");
	});

	it("asks the maintainer and stops until they answer", async () => {
		const stub = await prepared([{ tool: "ask_maintainer", args: { question: "Should renames keep the scroll position?" } }]);
		await start(stub);
		const list = await eventually(stub, (agent) => agent.activities(), (value) => value.some((activity) => activity.type === "elicitation"));
		expect(list).toContainEqual({ type: "elicitation", body: "Should renames keep the scroll position?" });
		// The question is the session's last activity, so Linear shows it as awaiting input.
		expect(list.at(-1)).toEqual({ type: "elicitation", body: "Should renames keep the scroll position?" });
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
			// A late review, CI failure or Linear message finds nothing to work on.
			await runInDurableObject(stub, (agent: TestIssueAgent) => agent.feedback({ text: "One more thing", requestId: "github:review:9" }));
			await runInDurableObject(stub, (agent: TestIssueAgent) =>
				agent.ciFailed({ branch: ISSUE.branchName, sha: "abc1234", runId: 1, name: "CI", url: "u", requestId: "github:run:1:1" }),
			);
			await runInDurableObject(stub, (agent: TestIssueAgent) => agent.steer({ sessionId: "session-1", text: "Keep going", requestId: "linear:late" }));
			expect(await runInDurableObject(stub, (agent: TestIssueAgent) => agent.stored())).toEqual([]);
		}
	});

	it("stops at once while a command is running, by destroying the container before aborting", async () => {
		for (const finish of [
			(agent: TestIssueAgent) => agent.stop(),
			(agent: TestIssueAgent) => agent.undelegated(),
		]) {
			const stub = await prepared([{ tool: "bash", args: { command: "npm run test:desktop" } }, { text: "Never sent." }]);
			await runInDurableObject(stub, (agent: TestIssueAgent) => agent.useHangingWorkspace());
			await start(stub);
			await eventually(stub, (agent) => agent.commandStarted(), (started) => started);
			// With the abort first, this would wait on the command, which only ends when the container goes.
			const began = Date.now();
			await runInDurableObject(stub, finish);
			expect(Date.now() - began).toBeLessThan(5_000);
			expect(await runInDurableObject(stub, (agent: TestIssueAgent) => agent.released())).toBe(true);
		}
	});

	it("runs on the model its issue's Model label picks, and only a whitelisted one", async () => {
		const picked = await prepared([{ text: "Fixed." }], { ...ISSUE, labels: [...ISSUE.labels, "Faux Two"] });
		await start(picked);
		const list = await eventually(picked, (agent) => agent.activities(), (value) => responses(value).length > 0);
		expect(list).toContainEqual({ type: "thought", body: "Working with Faux Two (faux-2), from the issue's Model label." });
		expect(await runInDurableObject(picked, (agent: TestIssueAgent) => agent.modelsUsed())).toEqual(["faux-2"]);

		const unknown = await prepared([{ text: "Fixed." }], { ...ISSUE, labels: [...ISSUE.labels, "faux-3"] });
		await start(unknown);
		await eventually(unknown, (agent) => agent.activities(), (value) => responses(value).length > 0);
		expect(await runInDurableObject(unknown, (agent: TestIssueAgent) => agent.modelsUsed())).toEqual(["faux-1"]);
	});

	it("switches model when it's delegated again after the Model label changed", async () => {
		const stub = await prepared([{ text: "First pass." }, { text: "Carried on." }]);
		await start(stub);
		await eventually(stub, (agent) => agent.activities(), (value) => responses(value).length === 1);
		await runInDurableObject(stub, (agent: TestIssueAgent) => {
			agent.setIssue({ ...ISSUE, labels: [...ISSUE.labels, "Faux Two"] });
			return agent.start({ issueId: ISSUE.id, sessionId: "session-2", prompt: "" });
		});
		await eventually(stub, (agent) => agent.activities(), (value) => responses(value).length === 2);
		expect(await runInDurableObject(stub, (agent: TestIssueAgent) => agent.modelsUsed())).toEqual(["faux-1", "faux-2"]);
	});

	it("doesn't carry on when it ended while reading the labels of a new session", async () => {
		const stub = await prepared([{ text: "First pass." }, { text: "Should not run." }]);
		await start(stub);
		await eventually(stub, (agent) => agent.activities(), (value) => responses(value).length === 1);
		await runInDurableObject(stub, async (agent: TestIssueAgent) => {
			const release = agent.holdIssue();
			// Not awaited: the PR closes while start() waits on Linear for the labels.
			const again = agent.start({ issueId: ISSUE.id, sessionId: "session-2", prompt: "" });
			await agent.closed({ merged: false });
			release();
			await again;
		});
		// Nothing came back: no issue, no session, no queued work.
		expect(await runInDurableObject(stub, (agent: TestIssueAgent) => agent.stored())).toEqual([]);
		expect(await env.BRANCHES.get(ISSUE.branchName)).toBeNull();
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
