import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { type FauxResponseStep, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { JsonObject } from "@earendil-works/pi-ai";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
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

	alarmAt(): Promise<number | null> {
		return this.ctx.storage.getAlarm();
	}

	modelCalls(): number {
		return this.ctx.storage.kv.get<Script>("test:script")?.next ?? 0;
	}

	protected override models(): Models {
		const faux = fauxProvider();
		faux.setResponses(Array.from({ length: 16 }, () => this.#step()));
		const models = createModels();
		models.setProvider(faux.provider);
		return models;
	}

	protected override linear(): LinearAgentClient {
		const kv = this.ctx.storage.kv;
		return {
			activity: async (_session, activity) => {
				kv.put("test:activities", [...(kv.get<Activity[]>("test:activities") ?? []), activity]);
			},
			addLink: async () => {},
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
		return { token: refuse, upsertPullRequest: refuse, isCollaborator: async () => false, failedJobs: async () => [] };
	}

	protected override workspace(): Promise<ExecutionEnv> {
		return Promise.reject(new Error("No workspace in tests"));
	}

	/** The next scripted response. The position is stored before the response is used, so a new instance continues. */
	#step(): FauxResponseStep {
		return (_request, options) => {
			const kv = this.ctx.storage.kv;
			const script = kv.get<Script>("test:script") ?? { steps: [], next: 0 };
			const step = script.steps[script.next] ?? { text: "unscripted" };
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
