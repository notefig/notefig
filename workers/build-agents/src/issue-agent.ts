import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { cloudflareAIGatewayProvider } from "@earendil-works/pi-ai/providers/cloudflare-ai-gateway";
import { type Conversation, createRegistry, defineExtension, Harness, section } from "@earendil-works/pi-durable";
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

interface Stored {
	session?: string;
	issue?: IssueDetails;
	prompt?: string;
}

export class IssueAgent extends DurableObject<Env> {
	readonly #config: Config;
	readonly #linear: LinearAgentClient;
	readonly #github: GitHubClient;
	#harness!: Harness;
	#workspace: Promise<ContainerEnv> | undefined;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.#config = readConfig(env);
		this.#linear = linearAgentClient({ clientId: env.LINEAR_CLIENT_ID, clientSecret: env.LINEAR_CLIENT_SECRET });
		this.#github = gitHubClient({ appId: env.GH_APP_ID, privateKey: env.GH_APP_PRIVATE_KEY }, this.#config.repo);
		void ctx.blockConcurrencyWhile(async () => {
			// A fallback before anything can throw: an object whose open or recovery fails is started again.
			const fallback = Date.now() + HEARTBEAT_MS;
			const current = await ctx.storage.getAlarm();
			if (current === null || current > fallback) await ctx.storage.setAlarm(fallback);
			this.#harness = await Harness.open(
				await openDurableObjectSqliteStorage(ctx.storage, { prefix: "pi_" }),
				{
					models: this.#models(),
					registry: this.#registry(),
					env: () => this.#environment(),
				},
				context,
			);
			this.#harness.resume();
			await this.#heartbeat();
		});
	}

	/** Delegated in Linear: check the issue, then start working on it. */
	async start(input: { issueId: string; sessionId: string; prompt: string }): Promise<void> {
		this.#put("session", input.sessionId);
		// Linear marks a session unresponsive without an activity within 10 seconds.
		await this.#post({ type: "thought", body: "Reading the issue." });
		const issue = await this.#linear.issue(input.issueId);
		if (issue.stateType === "triage") {
			return this.#post({ type: "response", body: "This issue is still in Triage. Accept it first, then delegate it again." });
		}
		const { testLabel } = this.#config;
		if (testLabel && !issue.labels.some((label) => label.toLowerCase() === testLabel.toLowerCase())) {
			return this.#post({ type: "response", body: `While the agent is in testing it only takes issues labelled "${testLabel}".` });
		}
		this.#put("issue", issue);
		this.#put("prompt", input.prompt);
		await this.env.BRANCHES.put(issue.branchName, issue.id);
		await this.#submit("Start working on the issue.", `linear:session:${input.sessionId}`, "followUp");
	}

	/** A maintainer's message in the Linear session: joins the running work at the next tool round. */
	async steer(input: { sessionId: string; text: string; requestId: string }): Promise<void> {
		this.#put("session", input.sessionId);
		await this.#submit(input.text, input.requestId, "steer");
	}

	/** Review feedback on the pull request, from someone the webhook trusts. */
	async feedback(input: { text: string; requestId: string }): Promise<void> {
		await this.#submit(input.text, input.requestId, "steer");
	}

	async ciFailed(input: { runId: number; name: string; url: string; requestId: string }): Promise<void> {
		const jobs = await this.#github.failedJobs(input.runId);
		const lines = jobs.map((job) => `- ${job.name}${job.steps.length ? `: ${job.steps.join(", ")}` : ""} (${job.url})`);
		const text = `CI failed on your branch: ${input.name} (${input.url}).\n${lines.join("\n")}\nReproduce it locally, fix it and push again.`;
		await this.#submit(text, input.requestId, "steer");
	}

	/** The session's stop button: abort the run and free the container. */
	async stop(): Promise<void> {
		await (await this.#root()).abort(context);
		await this.#heartbeat();
		await this.#release();
		await this.#post({ type: "response", body: "Stopped. Send a message to pick it up again." });
	}

	/** The pull request merged or closed: nothing more to do on this branch. */
	async closed(input: { merged: boolean }): Promise<void> {
		await (await this.#root()).abort(context);
		await this.#heartbeat();
		await this.#release();
		const issue = this.#get("issue");
		if (issue) await this.env.BRANCHES.delete(issue.branchName);
		await this.#post({ type: "response", body: input.merged ? "The pull request was merged." : "The pull request was closed." });
	}

	override async alarm(): Promise<void> {
		this.#harness.resume();
		await this.#heartbeat();
	}

	async #submit(content: string, requestId: string, whenBusy: "steer" | "followUp"): Promise<void> {
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

	#models() {
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
				upsertPullRequest: async (input) => {
					const pr = await this.#github.upsertPullRequest(input);
					const session = this.#get("session");
					if (session) await this.#linear.addLink(session, `Pull request #${pr.number}`, pr.url).catch(() => {});
					return pr;
				},
				ask: (question) => this.#post({ type: "elicitation", body: question }),
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
		if (session) await this.#linear.activity(session, activity);
	}

	/** The container with the repository on the issue's branch, started and cloned on first use. */
	#environment(): Promise<ContainerEnv> {
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
		if (!container.running) {
			const image = container.images.workspace ?? Object.values(container.images)[0];
			if (!image) throw new Error("No container image is configured");
			container.start({
				image,
				enableInternet: false,
				instance: "standard-2",
				env: { GIT_SSL_CAINFO: CONTAINER_CA, NODE_EXTRA_CA_CERTS: CONTAINER_CA, CARGO_HTTP_CAINFO: CONTAINER_CA },
			});
		}
		await this.#interceptGit(false);
		const registries = this.ctx.exports.RegistryGateway({});
		for (const host of REGISTRY_HOSTS) await container.interceptOutboundHttps(host, registries);

		const env = new ContainerEnv(container, { id: `container:${this.ctx.id.toString()}`, cwd: "/" });
		await ready(env);
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
