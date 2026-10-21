import { signedBy } from "./signature.ts";

/**
 * The GitHub App's webhook, turned into feedback for the agent whose branch it's about: reviews and comments on its
 * pull request (inline or in its conversation), a failed CI run on its branch, and the pull request closing. Only for branches of this repository: a
 * fork can open a pull request from a branch with the same name, and its events must not reach the agent. Which agent
 * it is, and whether a listed bot is trusted too, is decided by the caller (`index.ts`).
 */

export type GitHubEvent =
	| { kind: "feedback"; branch: string; author: string; text: string; requestId: string }
	/** A comment in a pull request's conversation: its payload names the pull request but not its branch. */
	| { kind: "pr_comment"; pullRequest: number; author: string; text: string; requestId: string }
	| { kind: "ci_failed"; branch: string; sha: string; runId: number; name: string; url: string; requestId: string }
	| { kind: "closed"; branch: string; merged: boolean };

export type GitHubOutcome =
	| { ok: false; status: number; error: string }
	| { ok: true; event: GitHubEvent | undefined };

interface Payload {
	action?: string;
	sender?: { login: string; type: string };
	pull_request?: { head: { ref: string; repo: { full_name: string } | null }; merged?: boolean; html_url: string };
	review?: { id: number; body: string | null; state: string; user: { login: string } };
	comment?: { id: number; body: string; path?: string; line?: number | null; user: { login: string } };
	issue?: { number: number; pull_request?: unknown };
	workflow_run?: {
		id: number;
		name: string;
		head_branch: string;
		head_sha: string;
		run_attempt?: number;
		head_repository: { full_name: string } | null;
		conclusion: string | null;
		html_url: string;
	};
}

export async function readGitHubWebhook(
	rawBody: string,
	signature: string | null,
	eventName: string | null,
	secret: string,
	repo: string,
): Promise<GitHubOutcome> {
	if (!(await signedBy(secret, rawBody, signature))) return { ok: false, status: 401, error: "Bad signature" };
	let payload: Payload;
	try {
		payload = JSON.parse(rawBody) as Payload;
	} catch {
		return { ok: false, status: 400, error: "Body is not JSON" };
	}
	// The app's own comments and pushes are not feedback.
	if (payload.sender?.type === "Bot" && payload.sender.login.startsWith("notefig-build-agent")) return { ok: true, event: undefined };
	return { ok: true, event: toEvent(eventName, payload, repo.toLowerCase()) };
}

function toEvent(eventName: string | null, payload: Payload, repo: string): GitHubEvent | undefined {
	const head = payload.pull_request?.head;
	const branch = head?.repo?.full_name.toLowerCase() === repo ? head.ref : undefined;
	switch (eventName) {
		case "pull_request_review": {
			const review = payload.review;
			if (payload.action !== "submitted" || !review || !branch) return undefined;
			if (!review.body?.trim() && review.state !== "changes_requested") return undefined;
			const state = review.state.replace(/_/g, " ");
			return {
				kind: "feedback",
				branch,
				author: review.user.login,
				text: `Review from ${review.user.login} (${state}):\n\n${review.body?.trim() || "(no summary)"}`,
				requestId: `github:review:${review.id}`,
			};
		}
		case "pull_request_review_comment": {
			const comment = payload.comment;
			if (payload.action !== "created" || !comment || !branch) return undefined;
			const where = comment.path ? ` on ${comment.path}${comment.line ? `:${comment.line}` : ""}` : "";
			return {
				kind: "feedback",
				branch,
				author: comment.user.login,
				text: `Review comment from ${comment.user.login}${where}:\n\n${comment.body}`,
				requestId: `github:review-comment:${comment.id}`,
			};
		}
		case "issue_comment": {
			// Issues and pull requests share these comments; only a pull request's reach the agent.
			const comment = payload.comment;
			if (payload.action !== "created" || !comment || !payload.issue?.pull_request) return undefined;
			return {
				kind: "pr_comment",
				pullRequest: payload.issue.number,
				author: comment.user.login,
				text: `Comment from ${comment.user.login} on the pull request:\n\n${comment.body}`,
				requestId: `github:comment:${comment.id}`,
			};
		}
		case "workflow_run": {
			const run = payload.workflow_run;
			if (payload.action !== "completed" || !run || run.conclusion !== "failure") return undefined;
			if (run.head_repository?.full_name.toLowerCase() !== repo) return undefined;
			return {
				kind: "ci_failed",
				branch: run.head_branch,
				sha: run.head_sha,
				runId: run.id,
				name: run.name,
				url: run.html_url,
				// A re-run keeps the run's id: the attempt makes each failure its own message.
				requestId: `github:run:${run.id}:${run.run_attempt ?? 1}`,
			};
		}
		case "pull_request":
			if (payload.action !== "closed" || !branch) return undefined;
			return { kind: "closed", branch, merged: payload.pull_request?.merged === true };
		default:
			return undefined;
	}
}
