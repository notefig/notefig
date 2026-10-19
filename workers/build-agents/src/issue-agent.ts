import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { cloudflareAIGatewayProvider } from "@earendil-works/pi-ai/providers/cloudflare-ai-gateway";
import { type Conversation, createRegistry, defineExtension, Harness, hook, section, ToolTask } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { type Config, type Env, readConfig } from "./config.ts";
import { ContainerEnv } from "./container-env.ts";
import { REGISTRY_HOSTS } from "./gateways.ts";
import { type GitHubClient, gitHubClient } from "./github.ts";
import { type Activity, type IssueDetails, type LinearAgentClient, linearAgentClient } from "./linear.ts";
import { INSTRUCTIONS, issueSection } from "./prompt.ts";
import { reporting } from "./reporting.ts";
import { agentTools } from "./tools.ts";

/**
 * One Linear issue's agent. The Durable Object hosts a Pi Durable harness on its own SQLite, so the transcript, the
 * running turn and queued feedback survive eviction and redeploys. While the harness has live tasks a heartbeat alarm
 * keeps coming back, so an evicted object restarts and `resume()` continues from the last checkpoint. (Pi's next release
 * adds `onWake`, which lets the harness say when it next needs to run; this heartbeat is the 1.3 equivalent.) It also owns the
 * container the agent works in, which holds a clone of the repository and nothing else: no tokens, no internet beyond
 * the hosts intercepted here.
 */

const context = BACKGROUND_CONTEXT;
const HEARTBEAT_MS = 60_000;
const REPO_DIR = "/workspace/repo";
const CONTAINER_CA = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
const CONTAINER_IDLE_MS = 10 * 60_000;

interface Stored {
	session?: string;
	/** The container's state after the last push, and the image it was taken on. */
	snapshot?: { id: string; image: string };
	issue?: IssueDetails;
	prompt?: string;
	/** Messages that arrived while the agent was still reading its issue. */
	pending?: { text: string; requestId: string }[];
}

export class IssueAgent extends DurableObject<Env> {
	readonly #config: Config;
	#linear: LinearAgentClient | undefined;
	#github: GitHubClient | undefined;
	#harness!: Harness;
	#workspace: Promise<ContainerEnv> | undefined;
	/** Why the workspace last failed to start, for the coding tools' error. */
	#workspaceError: string | undefined;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.#config = readConfig(env);
		void ctx.blockConcurrencyWhile(async () => {
			// A fallback before anything can throw: an object whose open or recovery fails is started again.
			const fallback = Date.now() + HEARTBEAT_MS;
			const current = await ctx.storage.getAlarm();
			if (current === null || current > fallback) await ctx.storage.setAlarm(fallback);
			this.#harness = await this.#open();
			await this.#current();
			this.#harness.resume();
			await this.#drainPending();
			await this.#heartbeat();
		});
	}

	/** The harness on the object's SQLite (tables prefixed `pi_`), with this process's models, registry and workspace. */
	async #open(): Promise<Harness> {
		return Harness.open(
			await openDurableObjectSqliteStorage(this.ctx.storage, { prefix: "pi_" }),
			{
				models: this.models(),
				registry: this.#registry(),
				// Pi 1.3 frees idle conversations and documents on timers, which would keep the object awake (and
				// billed) and stop it from being evicted. Freeing them at once costs a reload on the next use.
				settings: { contextRetentionMs: 0, documentRetentionMs: 0 },
				// A workspace that won't start fails only the tools that need it; the others (asking the maintainer,
				// the pull request) still run, and coding tools get the reason in their error.
				env: () =>
					this.workspace().then(
						(workspace) => {
							this.#workspaceError = undefined;
							return workspace;
						},
						(error: unknown) => {
							this.#workspaceError = error instanceof Error ? error.message : String(error);
							console.error("workspace unavailable", error);
							return undefined;
						},
					),
			},
			context,
		);
	}

	/**
	 * A conversation keeps the instructions and model it was created with. After a release changes either, an agent
	 * that is already running picks the new ones up here, from its next model request on.
	 */
	async #current(): Promise<void> {
		const root = await this.#root();
		const agent = await root.agent(context);
		const { model } = this.#config;
		const stale =
			agent.instructions !== INSTRUCTIONS || agent.model?.provider !== model.provider || agent.model?.modelId !== model.modelId;
		if (stale) await root.configure({ instructions: INSTRUCTIONS, model }, context);
	}

	/** Delegated in Linear: check the issue, then start working on it. */
	async start(input: { issueId: string; sessionId: string; prompt: string }): Promise<void> {
		// Already accepted (delegated again, or a redelivery): carry on in the newest session.
		if (this.#get("issue")) {
			this.#put("session", input.sessionId);
			await this.#post({ type: "thought", body: "Picking this up again." });
			await this.#submit("Continue working on the issue.", `linear:session:${input.sessionId}`, "followUp");
			return;
		}
		// Starting: messages arriving before the issue is accepted wait in `pending` (see `steer`).
		this.#put("session", input.sessionId);
		let issue: IssueDetails;
		try {
			// Linear marks a session unresponsive without an activity within 10 seconds.
			await this.#post({ type: "thought", body: "Reading the issue." });
			issue = await this.linear().issue(input.issueId);
		} catch (error) {
			await this.#refuse(`I couldn't read the issue: ${error instanceof Error ? error.message : String(error)}`, "error");
			throw error;
		}
		if (issue.stateType === "triage") {
			return this.#refuse("This issue is still in Triage. Accept it first, then delegate it again.");
		}
		const { testLabel } = this.#config;
		if (testLabel && !issue.labels.some((label) => label.toLowerCase() === testLabel.toLowerCase())) {
			return this.#refuse(`While the agent is in testing it only takes issues labelled "${testLabel}".`);
		}
		this.#put("issue", issue);
		this.#put("prompt", input.prompt);
		// The issue shows it's being worked on. Draft PRs don't move it, and an issue already further along stays put.
		if ((issue.stateType === "backlog" || issue.stateType === "unstarted") && issue.startedStateId) {
			await this.linear()
				.moveIssue(issue.id, issue.startedStateId)
				.catch((error: unknown) => console.error("linear: issue not moved to started", error));
		}
		await this.env.BRANCHES.put(issue.branchName, issue.id);
		await this.#submit("Start working on the issue.", `linear:session:${input.sessionId}`, "followUp");
		await this.#drainPending();
	}

	/**
	 * Submits the messages that arrived while the issue was being read, in order, each removed only once it's admitted.
	 * Also run on every start of the object and alarm, so a restart in between loses none; a message submitted twice is
	 * admitted once, by its request id.
	 */
	async #drainPending(): Promise<void> {
		if (!this.#get("issue")) return;
		for (let pending = this.#get("pending") ?? []; pending.length > 0; pending = this.#get("pending") ?? []) {
			const [message, ...rest] = pending;
			await this.#submit(message.text, message.requestId, "steer");
			if (rest.length > 0) this.#put("pending", rest);
			else this.ctx.storage.kv.delete("pending");
		}
	}

	/**
	 * Turns down a delegation that was never accepted: says why, and keeps nothing, so later messages for it are
	 * dropped. (An accepted issue never gets here: `start` carries on with it instead.)
	 */
	async #refuse(body: string, type: "response" | "error" = "response"): Promise<void> {
		await this.#post({ type, body }).catch((error: unknown) => console.error("linear: refusal not posted", error));
		this.ctx.storage.kv.delete("pending");
		this.ctx.storage.kv.delete("session");
	}

	/**
	 * A maintainer's message in the Linear session: joins the running work at the next tool round. While the agent is
	 * still starting (reading the issue), it waits until the issue is accepted; with no delegation at all (never
	 * delegated, refused, or ended), it's dropped.
	 */
	async steer(input: { sessionId: string; text: string; requestId: string }): Promise<void> {
		if (this.#get("issue")) {
			this.#put("session", input.sessionId);
			await this.#submit(input.text, input.requestId, "steer");
		} else if (this.#get("session")) {
			this.#put("pending", [...(this.#get("pending") ?? []), { text: input.text, requestId: input.requestId }]);
		}
	}

	/** Review feedback on the pull request, from someone the webhook trusts. Ignored once the agent has ended. */
	async feedback(input: { text: string; requestId: string }): Promise<void> {
		if (!this.#get("issue")) return;
		await this.#submit(input.text, input.requestId, "steer");
	}

	async ciFailed(input: { branch: string; sha: string; runId: number; name: string; url: string; requestId: string }): Promise<void> {
		if (!this.#get("issue")) return;
		const jobs = await this.github().failedJobs(input.runId);
		const sections = jobs.map((job) =>
			[
				`### ${job.name}${job.steps.length ? ` (failed step: ${job.steps.join(", ")})` : ""}`,
				job.url,
				...(job.logTail ? ["The end of its log:", "```", job.logTail, "```"] : []),
			].join("\n"),
		);
		const text = [
			`CI failed on your branch: ${input.name}, on commit ${input.sha.slice(0, 7)} (${input.url}).`,
			// Someone else may have pushed to the branch since your last push.
			`If your clone doesn't have that commit, run \`git pull --rebase origin ${input.branch}\` first.`,
			"",
			...sections,
			"",
			"Reproduce it locally, fix it, and push again.",
		].join("\n");
		await this.#submit(text, input.requestId, "steer");
	}


	/**
	 * The session's stop button: a pause. The run is aborted and the container destroyed, but the transcript stays, so
	 * a message picks the work up again. A stopped agent costs only its stored state.
	 */
	async stop(): Promise<void> {
		await (await this.#root()).abort(context);
		await this.#heartbeat();
		await this.#release();
		await this.#post({ type: "response", body: "Stopped. Send a message to pick it up again." });
	}

	/** Unassigned in Linear (removed as the delegate, or delegated elsewhere): the agent's work on this issue is over. */
	async undelegated(): Promise<void> {
		await this.#end("Unassigned, so I've stopped and cleared my workspace. Delegate the issue again to start over.");
	}

	/** The pull request merged or closed: nothing more to do on this branch. */
	async closed(input: { merged: boolean }): Promise<void> {
		await this.#end(input.merged ? "The pull request was merged." : "The pull request was closed.");
	}

	/**
	 * Ends the agent for good, so it costs nothing afterwards: aborts any run, destroys the container, removes the
	 * branch mapping (so GitHub events no longer reach it), says so on the session, and erases the object's storage
	 * (transcript, checkpoints, snapshot record, alarm). A new delegation starts afresh.
	 */
	async #end(farewell: string): Promise<void> {
		const issue = this.#get("issue");
		await (await this.#root()).abort(context);
		await this.#release();
		if (issue) await this.env.BRANCHES.delete(issue.branchName);
		await this.#post({ type: "response", body: farewell }).catch((error: unknown) => console.error("linear: farewell not posted", error));
		await this.#harness.close(context);
		await this.ctx.storage.deleteAlarm();
		await this.ctx.storage.deleteAll();
		// A harness on the now empty storage, so this instance is as fresh as a new one; it stores nothing until the
		// issue is delegated again.
		this.#harness = await this.#open();
	}

	override async alarm(): Promise<void> {
		this.#harness.resume();
		await this.#drainPending();
		await this.#heartbeat();
	}

	async #submit(content: string, requestId: string, whenBusy: "steer" | "followUp"): Promise<void> {
		// Checked here, at the moment of admitting, as well as on the way in: an event already waiting on the network
		// (a CI failure fetching its logs) when the agent ended must not start it again. Only a delegation stores an issue.
		if (!this.#get("issue")) return;
		// Armed before admitting work: an object that dies after the commit is still woken.
		await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
		const root = await this.#root();
		await root.submit({ type: "input", content, requestId, ...(whenBusy === "steer" ? { whenBusy: "steer" } : {}) }, context);
	}

	#root(): Promise<Conversation> {
		return this.#harness.root(context, {
			agent: { model: this.#config.model, instructions: INSTRUCTIONS, cwd: REPO_DIR },
		});
	}

	/** A recovery heartbeat while the harness has live tasks; none once it's idle, so the object can sleep. */
	async #heartbeat(): Promise<void> {
		const { tasks } = await this.#harness.inspect(context);
		if (tasks.length > 0) await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
		else await this.ctx.storage.deleteAlarm();
	}

	// The outside world, one method each, so tests can stand in for it (`test/issue-agent.ts`).

	/** Linear, as the agent's own app. */
	protected linear(): LinearAgentClient {
		this.#linear ??= linearAgentClient({ clientId: this.env.LINEAR_CLIENT_ID, clientSecret: this.env.LINEAR_CLIENT_SECRET });
		return this.#linear;
	}

	/** GitHub, as the agent's GitHub App. */
	protected github(): GitHubClient {
		this.#github ??= gitHubClient({ appId: this.env.GH_APP_ID, privateKey: this.env.GH_APP_PRIVATE_KEY }, this.#config.repo);
		return this.#github;
	}

	/** The models, through AI Gateway. */
	protected models(): Models {
		const values: Record<string, string> = {
			CLOUDFLARE_API_KEY: this.env.AI_GATEWAY_TOKEN,
			CLOUDFLARE_ACCOUNT_ID: this.env.CLOUDFLARE_ACCOUNT_ID,
			CLOUDFLARE_GATEWAY_ID: this.env.AI_GATEWAY_ID,
		};
		const models = createModels({ authContext: { env: async (name) => values[name], fileExists: async () => false } });
		models.setProvider(cloudflareAIGatewayProvider());
		return models;
	}

	#registry() {
		const registry = createRegistry();
		registry.install(CodingTools);
		registry.install(
			agentTools({
				issue: async () => this.#issue(),
				typeLabels: this.#config.typeLabels,
				draft: (issue) =>
					this.#config.testLabel !== undefined &&
					issue.labels.some((label) => label.toLowerCase() === this.#config.testLabel?.toLowerCase()),
				permitPush: (permitted) => this.#interceptGit(permitted),
				pushed: () => this.#checkpoint(),
				upsertPullRequest: async (input) => {
					const pr = await this.github().upsertPullRequest(input);
					const session = this.#get("session");
					if (session) await this.linear().addLink(session, `Pull request #${pr.number}`, pr.url).catch(() => {});
					return pr;
				},
				ask: (question) => this.#post({ type: "elicitation", body: question }),
			}),
		);
		registry.install(
			defineExtension({
				name: "notefig.workspace",
				hooks: [
					hook(ToolTask, {
						// Pi's coding tools say only that there is no environment; say why the container didn't start.
						afterTool: (_call, result) => {
							const reason = this.#workspaceError;
							const text = result.output?.map((part) => ("text" in part ? part.text : "")).join("") ?? "";
							if (!result.isError || !reason || !text.includes("No execution environment")) return undefined;
							return { ...result, output: [{ type: "text", text: `The workspace couldn't start: ${reason}` }] };
						},
					}),
				],
			}),
		);
		registry.install(reporting((activity) => this.#post(activity)));
		registry.install(
			defineExtension({
				name: "notefig.issue",
				sections: [section("issue", () => {
					const issue = this.#get("issue");
					return issue ? issueSection(issue, this.#get("prompt") ?? "") : undefined;
				})],
			}),
		);
		return registry;
	}

	async #issue(): Promise<IssueDetails> {
		const issue = this.#get("issue");
		if (!issue) throw new Error("This agent has no issue yet");
		return issue;
	}

	async #post(activity: Activity): Promise<void> {
		const session = this.#get("session");
		if (session) await this.linear().activity(session, activity);
	}

	/** Where tools run: the container with the repository on the issue's branch, started and cloned on first use. */
	protected workspace(): Promise<ExecutionEnv> {
		const container = this.ctx.container;
		if (!container) return Promise.reject(new Error("This Durable Object has no container"));
		if (!this.#workspace || !container.running) {
			this.#workspace = this.#prepare(container).catch((error: unknown) => {
				this.#workspace = undefined;
				throw error;
			});
		}
		return this.#workspace;
	}

	async #prepare(container: Container): Promise<ContainerEnv> {
		const issue = await this.#issue();
		const env = new ContainerEnv(container, { id: `container:${this.ctx.id.toString()}`, cwd: "/" });
		if (!container.running) {
			const image = container.images.workspace ?? Object.values(container.images)[0];
			if (!image) throw new Error("No container image is configured");
			// The last pushed state, if it was taken on this image; a new release starts from a fresh clone.
			const snapshot = this.#get("snapshot");
			const resumed = snapshot?.image === image && (await this.#start(container, env, { containerSnapshot: { id: snapshot.id } }));
			if (!resumed) {
				if (snapshot) this.ctx.storage.kv.delete("snapshot");
				await this.#start(container, env, { image }, true);
			}
			// An agent waiting days for a review doesn't keep its container running; the next tool call restarts it.
			await container.setInactivityTimeout(CONTAINER_IDLE_MS);
		}

		const exists = await env.exists(`${REPO_DIR}/.git`, context);
		if (!exists.ok || !exists.value) {
			const { owner, name } = this.#config.repo;
			const branch = issue.branchName;
			const script = [
				`git clone --quiet https://github.com/${owner}/${name}.git ${REPO_DIR}`,
				`cd ${REPO_DIR}`,
				`git config user.name ${JSON.stringify(this.#config.gitAuthor.name)}`,
				`git config user.email ${JSON.stringify(this.#config.gitAuthor.email)}`,
				`(git fetch --quiet origin ${branch} && git checkout --quiet -B ${branch} origin/${branch}) || git checkout --quiet -b ${branch}`,
			].join(" && ");
			let output = "";
			const cloned = await env.exec(script, { onOutput: (text) => (output += text) }, context);
			if (!cloned.ok || cloned.value.exitCode !== 0) throw new Error(`Could not clone the repository:\n${output}`);
		}
		env.cwd = REPO_DIR;
		return env;
	}

	/**
	 * Starts the container from `source` with internet off and the intercepts in place, and waits until it runs
	 * commands. A snapshot that won't start is given up on (false); a fresh image that won't start is an error.
	 */
	async #start(container: Container, env: ContainerEnv, source: { image: string } | { containerSnapshot: { id: string } }, required = false): Promise<boolean> {
		try {
			container.start({
				...source,
				enableInternet: false,
				instance: "standard-2",
				env: { GIT_SSL_CAINFO: CONTAINER_CA, NODE_EXTRA_CA_CERTS: CONTAINER_CA, CARGO_HTTP_CAINFO: CONTAINER_CA },
			} as ContainerStartupOptions);
			await this.#interceptGit(false);
			const registries = this.ctx.exports.RegistryGateway({});
			for (const host of REGISTRY_HOSTS) await container.interceptOutboundHttps(host, registries);
			await ready(env);
			return true;
		} catch (error) {
			if (required) throw error;
			console.error("container: snapshot did not start, cloning instead", error);
			if (container.running) await container.destroy();
			return false;
		}
	}

	/** After a push: the container as it is, so a restart resumes with the clone, dependencies and build caches. */
	async #checkpoint(): Promise<void> {
		const container = this.ctx.container;
		const image = container?.images.workspace ?? Object.values(container?.images ?? {})[0];
		if (!container?.running || !image) return;
		try {
			const snapshot = await container.snapshotContainer({ name: this.#get("issue")?.identifier });
			this.#put("snapshot", { id: snapshot.id, image });
		} catch (error) {
			// An older snapshot would restore a checkout without this push; without one, the next start clones the branch.
			this.ctx.storage.kv.delete("snapshot");
			console.error("container: snapshot failed", error);
		}
	}


	/** git to `github.com` goes through `GitGateway`, which pushes only to the issue's branch, and only when permitted. */
	async #interceptGit(push: boolean): Promise<void> {
		const container = this.ctx.container;
		const issue = this.#get("issue");
		if (!container || !issue) throw new Error("No container or issue");
		await container.interceptOutboundHttps("github.com", this.ctx.exports.GitGateway({ props: { branch: issue.branchName, push } }));
	}

	async #release(): Promise<void> {
		this.#workspace = undefined;
		if (this.ctx.container?.running) await this.ctx.container.destroy();
	}

	#get<K extends keyof Stored>(key: K): Stored[K] {
		return this.ctx.storage.kv.get<Stored[K]>(key);
	}

	#put<K extends keyof Stored>(key: K, value: NonNullable<Stored[K]>): void {
		this.ctx.storage.kv.put(key, value);
	}
}

/** Waits for a just-started container to run commands. */
async function ready(env: ContainerEnv): Promise<void> {
	for (let attempt = 0; attempt < 60; attempt++) {
		const result = await env.exec(["true"], undefined, context).catch(() => undefined);
		if (result?.ok) return;
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
	throw new Error("The container did not start");
}
