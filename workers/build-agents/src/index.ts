import { type Env, readConfig } from "./config.ts";
import { type GitHubEvent, readGitHubWebhook } from "./github-webhook.ts";
import { gitHubClient } from "./github.ts";
import { type AgentCommand, readLinearWebhook } from "./linear-webhook.ts";

export { GitGateway, RegistryGateway } from "./gateways.ts";
export { IssueAgent } from "./issue-agent.ts";

/**
 * agents.notefig.com. Two webhooks in, each handed to the Durable Object of the issue it's about:
 *
 * - `POST /v1/linear`: Linear's agent session events (delegated, a message, stop).
 * - `POST /v1/github`: the GitHub App's events on the agent's pull requests and branches.
 *
 * Both answer as soon as the event is verified and handed over; Linear wants an answer within five seconds.
 */

const MAX_BODY_BYTES = 1024 * 1024;

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);
		// Where Linear returns after an admin installs the app (the link bootstrap prints). The install itself is done.
		if (request.method === "GET" && url.pathname === "/v1/linear/installed") {
			return new Response("The build agent is installed in Linear. You can close this tab.\n");
		}
		if (request.method !== "POST") return json(405, { error: "Method not allowed" });
		const body = await request.text();
		if (body.length > MAX_BODY_BYTES) return json(413, { error: "Body too large" });

		if (url.pathname === "/v1/linear") {
			const outcome = await readLinearWebhook(
				body,
				request.headers.get("Linear-Signature"),
				env.LINEAR_WEBHOOK_SECRET,
				readConfig(env),
				Date.now(),
			);
			if (!outcome.ok) return json(outcome.status, { error: outcome.error });
			if (outcome.command) ctx.waitUntil(runLinear(env, outcome.command));
			return json(200, { outcome: outcome.command?.kind ?? "ignored", reason: outcome.reason });
		}

		if (url.pathname === "/v1/github") {
			const outcome = await readGitHubWebhook(
				body,
				request.headers.get("X-Hub-Signature-256"),
				request.headers.get("X-GitHub-Event"),
				env.GH_APP_WEBHOOK_SECRET,
				env.GITHUB_REPO,
			);
			if (!outcome.ok) return json(outcome.status, { error: outcome.error });
			if (outcome.event) ctx.waitUntil(runGitHub(env, outcome.event));
			return json(200, { outcome: outcome.event?.kind ?? "ignored" });
		}

		return json(404, { error: "Not found" });
	},
} satisfies ExportedHandler<Env>;

function agent(env: Env, issueId: string) {
	return env.ISSUE_AGENT.getByName(issueId);
}

async function runLinear(env: Env, command: AgentCommand): Promise<void> {
	const stub = agent(env, command.issueId);
	try {
		if (command.kind === "start") await stub.start(command);
		else if (command.kind === "steer") await stub.steer(command);
		else await stub.stop();
	} catch (error) {
		console.error(`linear ${command.kind} failed`, error);
	}
}

async function runGitHub(env: Env, event: GitHubEvent): Promise<void> {
	const issueId = await env.BRANCHES.get(event.branch);
	if (!issueId) return;
	const stub = agent(env, issueId);
	try {
		if (event.kind === "closed") return await stub.closed(event);
		if (event.kind === "ci_failed") return await stub.ciFailed(event);
		if (!(await trusted(env, event.author))) return;
		await stub.feedback(event);
	} catch (error) {
		console.error(`github ${event.kind} failed`, error);
	}
}

/** A review reaches the agent only from a collaborator or a listed bot; the repository is public. */
async function trusted(env: Env, login: string): Promise<boolean> {
	const config = readConfig(env);
	if (config.trustedReviewers.includes(login.toLowerCase())) return true;
	return gitHubClient({ appId: env.GH_APP_ID, privateKey: env.GH_APP_PRIVATE_KEY }, config.repo).isCollaborator(login);
}

function json(status: number, body: unknown): Response {
	return Response.json(body, { status });
}
