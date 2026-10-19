import { describe, expect, it } from "vitest";
import { readGitHubWebhook } from "./github-webhook.ts";
import { sign } from "../test/sign.ts";

const SECRET = "github-webhook-secret";
const REPO = "notefig/notefig";

async function read(eventName: string, payload: unknown) {
	const raw = JSON.stringify(payload);
	return readGitHubWebhook(raw, `sha256=${await sign(SECRET, raw)}`, eventName, SECRET, REPO);
}

const pullRequest = (repo: string) => ({ head: { ref: "parsa/met-42-sidebar", repo: { full_name: repo } }, html_url: "u" });

describe("readGitHubWebhook", () => {
	it("turns a review on the agent's pull request into feedback", async () => {
		const outcome = await read("pull_request_review", {
			action: "submitted",
			pull_request: pullRequest(REPO),
			review: { id: 7, body: "Use the helper", state: "changes_requested", user: { login: "parsasi" } },
		});
		expect(outcome).toEqual({
			ok: true,
			event: {
				kind: "feedback",
				branch: "parsa/met-42-sidebar",
				author: "parsasi",
				text: "Review from parsasi (changes requested):\n\nUse the helper",
				requestId: "github:review:7",
			},
		});
	});

	it("ignores a fork's pull request from a branch with the agent's branch name", async () => {
		const closed = await read("pull_request", { action: "closed", pull_request: { ...pullRequest("someone/notefig"), merged: false } });
		expect(closed).toEqual({ ok: true, event: undefined });
		const run = await read("workflow_run", {
			action: "completed",
			workflow_run: { id: 1, name: "CI", head_branch: "parsa/met-42-sidebar", head_repository: { full_name: "someone/notefig" }, conclusion: "failure", html_url: "u" },
		});
		expect(run).toEqual({ ok: true, event: undefined });
	});

	it("reports a failed run and a merge on the repository's own branch", async () => {
		expect(
			await read("workflow_run", {
				action: "completed",
				workflow_run: { id: 9, name: "CI", head_branch: "b", head_repository: { full_name: REPO }, conclusion: "failure", html_url: "u" },
			}),
		).toMatchObject({ ok: true, event: { kind: "ci_failed", runId: 9, branch: "b" } });
		expect(await read("pull_request", { action: "closed", pull_request: { ...pullRequest(REPO), merged: true } })).toEqual({
			ok: true,
			event: { kind: "closed", branch: "parsa/met-42-sidebar", merged: true },
		});
	});

	it("ignores the app's own activity", async () => {
		const outcome = await read("pull_request_review", {
			action: "submitted",
			sender: { login: "notefig-build-agent[bot]", type: "Bot" },
			pull_request: pullRequest(REPO),
			review: { id: 8, body: "x", state: "commented", user: { login: "notefig-build-agent[bot]" } },
		});
		expect(outcome).toEqual({ ok: true, event: undefined });
	});
});
