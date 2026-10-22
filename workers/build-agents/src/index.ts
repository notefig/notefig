import { type Env, issueKey, readConfig } from "./config.ts";
import { type GitHubEvent, readGitHubWebhook } from "./github-webhook.ts";
import { gitHubClient } from "./github.ts";
import { linearAgentClient } from "./linear.ts";
import { type AgentCommand, commentForAgent, readLinearWebhook } from "./linear-webhook.ts";

export { GitGateway, RegistryGateway } from "./gateways.ts";
export { IssueAgent } from "./issue-agent.ts";

/**
 * agents.notefig.com. Two webhooks in, each handed to the Durable Object of the issue it's about:
 *
 * - `POST /v1/linear`: Linear's agent session events (delegated, a message, stop), issue updates (unassigned, done,
 *   cancelled, deleted) and comments on the issue.
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
		else if (command.kind === "stop") await stub.stop();
		else if (command.kind === "comment") {
			const linear = linearAgentClient({ clientId: env.LINEAR_CLIENT_ID, clientSecret: env.LINEAR_CLIENT_SECRET });
			const comment = await linear.comment(command.commentId);
			const ignored = commentForAgent(comment, await linear.appUser(), readConfig(env));
			if (ignored) return console.log(`linear: ignored comment ${comment.id}: ${ignored}`);
			await stub.feedback({
				text: `Comment from ${comment.author?.name} on the Linear issue:\n\n${comment.body.trim()}`,
				requestId: `linear:comment:${comment.id}`,
			});
		} else if (command.kind === "ended") {
			// Only an issue an agent took: one started before its issue key was kept is found by its delegate.
			if (!(await env.BRANCHES.get(issueKey(command.issueId)))) {
				const app = await linearAgentClient({ clientId: env.LINEAR_CLIENT_ID, clientSecret: env.LINEAR_CLIENT_SECRET }).appUser();
				if (!command.delegateIds.includes(app.id)) return;
			}
			await stub.ended(command.why);
		} else {
			// Unassigned: stop only if the issue was this app's to work on.
			const app = await linearAgentClient({ clientId: env.LINEAR_CLIENT_ID, clientSecret: env.LINEAR_CLIENT_SECRET }).appUser();
			if (command.previousDelegateId === app.id) await stub.undelegated();
		}
	} catch (error) {
		console.error(`linear ${command.kind} failed`, error);
	}
}

async function runGitHub(env: Env, event: GitHubEvent): Promise<void> {
	try {
		const branch = event.kind === "pr_comment" ? await commentedBranch(env, event.pullRequest) : event.branch;
		const issueId = branch && (await env.BRANCHES.get(branch));
		if (!issueId) return;
		const stub = agent(env, issueId);
		if (event.kind === "closed") return await stub.closed(event);
		if (event.kind === "ci_failed") return await stub.ciFailed(event);
		if (!(await trusted(env, event))) {
			console.log(`github: ignored ${event.requestId} from ${event.author}, who can't push to the repository`);
			return;
		}
		await stub.feedback(event);
	} catch (error) {
		console.error(`github ${event.kind} failed`, error);
	}
}

/** The branch of a commented pull request, unless it's a fork's: a fork's branch can share the agent's name. */
async function commentedBranch(env: Env, pullRequest: number): Promise<string | undefined> {
	const config = readConfig(env);
	const head = await gitHubClient({ appId: env.GH_APP_ID, privateKey: env.GH_APP_PRIVATE_KEY }, config.repo).pullRequestHead(pullRequest);
	return head?.repo?.toLowerCase() === env.GITHUB_REPO.toLowerCase() ? head.branch : undefined;
}

/**
 * A review reaches the agent only from someone who can push to the repository, or a listed bot; the repository is
 * public. GitHub's `author_association` can't settle it: MEMBER and COLLABORATOR don't mean write access, and a
 * private org membership shows as CONTRIBUTOR. So every human reviewer is checked against their permission.
 */
async function trusted(env: Env, event: { author: string }): Promise<boolean> {
	const config = readConfig(env);
	if (config.trustedReviewers.includes(event.author.toLowerCase())) return true;
	return gitHubClient({ appId: env.GH_APP_ID, privateKey: env.GH_APP_PRIVATE_KEY }, config.repo).canWrite(event.author);
}

function json(status: number, body: unknown): Response {
	return Response.json(body, { status });
}
