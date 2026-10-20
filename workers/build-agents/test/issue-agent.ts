import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { type FauxResponseStep, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { JsonObject } from "@earendil-works/pi-ai";
import { type ExecutionEnv, ExecutionError } from "@earendil-works/pi-durable/env";
import type { Env } from "../src/config.ts";
import type { GitHubClient } from "../src/github.ts";
import { IssueAgent } from "../src/issue-agent.ts";
import type { Activity, IssueDetails, LinearAgentClient } from "../src/linear.ts";

/**
 * `IssueAgent` with the outside world replaced, for tests in workerd: a scripted model, and Linear and GitHub that
 * record what the agent sends. Everything lives in the object's own storage, so it survives an eviction the way the
 * agent's state does.
 */

/** One scripted model response: text, a tool call, or `hang` (wait until the request is aborted). */
export type Step = { text: string } | { tool: string; args: JsonObject } | "hang";

type Script = { steps: Step[]; next: number };

export const ISSUE: IssueDetails = {
	id: "issue-1",
	identifier: "MET-42",
	title: "Sidebar flickers on rename",
	url: "https://linear.app/notefig/issue/MET-42",
	branchName: "parsa/met-42-sidebar-flickers",
	labels: ["Bug", "agent-test"],
	description: "The tree jumps when I rename a file.",
	teamKey: "MET",
	stateType: "started",
	startedStateId: "state-in-progress",
	privateNote: undefined,
};

export class TestIssueAgent extends IssueAgent {
	/** Resolves when this instance's model request starts and hangs. */
	readonly hanging: Promise<void>;
	#hung!: () => void;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.hanging = new Promise((resolve) => (this.#hung = resolve));
	}

	script(steps: Step[]): void {
		this.ctx.storage.kv.put("test:script", { steps, next: 0 } satisfies Script);
	}

	setIssue(issue: IssueDetails): void {
		this.ctx.storage.kv.put("test:issue", issue);
	}

	activities(): Activity[] {
		return this.ctx.storage.kv.get<Activity[]>("test:activities") ?? [];
	}

	/** Leaves messages in the start-up queue, as a restart in the middle of draining it would. */
	queue(messages: { text: string; requestId: string }[]): void {
		this.ctx.storage.kv.put("pending", messages);
	}

	/** Everything the object has stored, by key: empty once it has ended. */
	stored(): string[] {
		return [...this.ctx.storage.kv.list()].map(([key]) => key);
	}

	alarmAt(): Promise<number | null> {
		return this.ctx.storage.getAlarm();
	}

	moves(): string[] {
		return this.ctx.storage.kv.get<string[]>("test:moves") ?? [];
	}

	/** The next `count` activity posts fail, as when Linear is briefly down. */
	failNextPosts(count: number): void {
		this.ctx.storage.kv.put("test:fail-posts", count);
	}

	storedPrompt(): string {
		return this.ctx.storage.kv.get<string>("prompt") ?? "";
	}

	lastToolResult(): string {
		return this.ctx.storage.kv.get<string>("test:last-tool-result") ?? "";
	}

	lastPrompt(): string {
		return this.ctx.storage.kv.get<string>("test:last-prompt") ?? "";
	}

	/** The model id of each request, in order. */
	modelsUsed(): string[] {
		return this.ctx.storage.kv.get<string[]>("test:models") ?? [];
	}

	modelCalls(): number {
		return this.ctx.storage.kv.get<Script>("test:script")?.next ?? 0;
	}

	protected override models(): Models {
		// The default model and the one `MODEL_LABELS` whitelists in test/wrangler.jsonc.
		const faux = fauxProvider({ models: [{ id: "faux-1" }, { id: "faux-2" }] });
		faux.setResponses(Array.from({ length: 16 }, () => this.#step()));
		const models = createModels();
		models.setProvider(faux.provider);
		return models;
	}

	protected override linear(): LinearAgentClient {
		const kv = this.ctx.storage.kv;
		return {
			activity: async (_session, activity) => {
				const failures = kv.get<number>("test:fail-posts") ?? 0;
				if (failures > 0) {
					kv.put("test:fail-posts", failures - 1);
					throw new Error("Linear is down");
				}
				kv.put("test:activities", [...(kv.get<Activity[]>("test:activities") ?? []), activity]);
			},
			addLink: async () => {},
			moveIssue: async (issueId, stateId) => {
				kv.put("test:moves", [...(kv.get<string[]>("test:moves") ?? []), `${issueId}→${stateId}`]);
			},
			appUserId: async () => "app-user",
			issue: async () => {
				const issue = kv.get<IssueDetails>("test:issue");
				if (!issue) throw new Error("No test issue");
				return issue;
			},
		};
	}

	protected override github(): GitHubClient {
		const refuse = async (): Promise<never> => {
			throw new Error("No GitHub in tests");
		};
		return { token: refuse, upsertPullRequest: refuse, canWrite: async () => false, failedJobs: async () => [] };
	}

	/** Gives the agent a workspace whose commands run until it's released, as a long test run in a container would. */
	useHangingWorkspace(): void {
		this.ctx.storage.kv.put("test:workspace", "hanging");
	}

	/** Whether a command has started in the hanging workspace. */
	commandStarted(): boolean {
		return this.ctx.storage.kv.get<boolean>("test:command-started") ?? false;
	}

	/** Whether the agent released (destroyed) its workspace. Kept outside the object, since ending it erases storage. */
	async released(): Promise<boolean> {
		return (await this.env.BRANCHES.get(`test:released:${this.ctx.id.toString()}`)) === "yes";
	}

	#release = deferred();

	protected override async release(): Promise<void> {
		await this.env.BRANCHES.put(`test:released:${this.ctx.id.toString()}`, "yes");
		this.#release.resolve();
		this.#release = deferred();
	}

	protected override workspace(): Promise<ExecutionEnv> {
		if (this.ctx.storage.kv.get("test:workspace") !== "hanging") return Promise.reject(new Error("No workspace in tests"));
		const kv = this.ctx.storage.kv;
		const ended = () => this.#release.promise;
		const env = {
			id: "hanging",
			cwd: "/workspace/repo",
			// A command that runs until the workspace is destroyed, then fails as a killed process does.
			exec: async () => {
				kv.put("test:command-started", true);
				await ended();
				return { ok: false, error: new ExecutionError("aborted", "Killed: the container was destroyed") };
			},
			cleanup: async () => {},
		};
		return Promise.resolve(env as unknown as ExecutionEnv);
	}

	/** The next scripted response. The position is stored before the response is used, so a new instance continues. */
	#step(): FauxResponseStep {
		return (_request, options, _state, model) => {
			const kv = this.ctx.storage.kv;
			kv.put("test:models", [...(kv.get<string[]>("test:models") ?? []), model.id]);
			const script = kv.get<Script>("test:script") ?? { steps: [], next: 0 };
			const step = script.steps[script.next] ?? { text: "unscripted" };
			// The newest user message the model was sent, for tests that check what reached it.
			const messages = (_request as { messages?: { role: string; content: unknown }[] }).messages ?? [];
			const user = [...messages].reverse().find((message) => message.role === "user");
			if (user) kv.put("test:last-prompt", JSON.stringify(user.content));
			const toolResult = [...messages].reverse().find((message) => message.role === "toolResult");
			if (toolResult) kv.put("test:last-tool-result", JSON.stringify(toolResult));
			kv.put("test:script", { ...script, next: script.next + 1 });
			if (step === "hang") {
				this.#hung();
				return new Promise((_resolve, reject) => {
					const abort = () => reject(new DOMException("Request interrupted", "AbortError"));
					if (options?.signal?.aborted) abort();
					else options?.signal?.addEventListener("abort", abort, { once: true });
				});
			}
			if ("tool" in step) return fauxAssistantMessage([fauxToolCall(step.tool, step.args)], { stopReason: "toolUse" });
			return fauxAssistantMessage(step.text);
		};
	}
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => (resolve = done));
	return { promise, resolve };
}
