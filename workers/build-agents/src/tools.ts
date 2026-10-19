import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { changeType, pullRequestBody, pullRequestTitle } from "./git-output.ts";
import type { PullRequest } from "./github.ts";
import type { IssueDetails } from "./linear.ts";
import { leaks, privateTokens } from "./privacy.ts";

/**
 * The agent's own tools, next to Pi's coding tools. They own everything that leaves the container: pushing (through
 * the git gateway, which only lets a push through while this tool holds the permit), the pull request, and questions
 * to the maintainer.
 */

/** What the tools need from the issue's Durable Object. */
export interface AgentHost {
	issue(): Promise<IssueDetails>;
	typeLabels: ReadonlyMap<string, string>;
	/** Draft pull requests while testing. */
	draft(issue: IssueDetails): boolean;
	permitPush(permitted: boolean): Promise<void>;
	/** After a successful push: a moment worth resuming from. */
	pushed(): Promise<void>;
	upsertPullRequest(input: { branch: string; title: string; body: string; draft: boolean }): Promise<PullRequest>;
	ask(question: string): Promise<void>;
}

const text = (value: string) => [{ type: "text" as const, text: value }];

async function run(api: ToolExecutionApi, command: string, context: Context): Promise<{ exitCode: number; output: string }> {
	if (!api.env) throw new Error("No workspace");
	let output = "";
	const result = await api.env.exec(command, { onOutput: (chunk) => (output += chunk) }, context);
	if (!result.ok) throw result.error;
	return { exitCode: result.value.exitCode, output };
}

function refuseLeaks(found: string[]): never {
	throw new Error(
		`This would publish details from the private note (${found.length} found, e.g. "${found[0]}"). Describe the problem in your own words instead.`,
	);
}

export function agentTools(host: AgentHost) {
	const push = defineTool({
		name: "push",
		description:
			"Push the committed work on the issue's branch to GitHub. The only way to push: it checks the commits for private details, and the desktop e2e suite runs in CI on the pull request instead of before the push. Commit before calling it.",
		parameters: Type.Object({}),
		execute: async (_args, api, context) => {
			const issue = await host.issue();
			await run(api, "git fetch --quiet origin main", context);
			// Every outgoing commit's message and its own patch: a value removed in a later commit is still in the history.
			// `--cc` includes what a merge commit itself introduces, which plain `--patch` leaves out.
			const commits = await run(api, "git log --patch --cc --format=%B%n%an%n%ae origin/main..HEAD", context);
			const found = leaks(commits.output, privateTokens(issue.privateNote));
			if (found.length > 0) refuseLeaks(found);
			await host.permitPush(true);
			try {
				// --no-verify skips only the repository's pre-push hook, which runs the whole desktop e2e suite in a browser:
				// minutes of container time per push, and CI runs the same suite on the pull request, whose failures come
				// back to the agent. The commit hook (Fallow) has already run.
				const pushed = await run(api, `git push --quiet --no-verify origin HEAD:refs/heads/${issue.branchName}`, context);
				if (pushed.exitCode !== 0) throw new Error(`git push failed:\n${pushed.output}`);
			} finally {
				await host.permitPush(false);
			}
			await host.pushed();
			return { output: text(`Pushed to ${issue.branchName}.`) };
		},
	});

	const openPullRequest = defineTool({
		name: "open_pull_request",
		description:
			"Open the pull request for the issue's branch, or update it. Push first. The title gets the issue's type, and the body gets the release notes and the line that closes the issue.",
		parameters: Type.Object({
			summary: Type.String({ description: "What changed, as a short sentence, e.g. 'The sidebar keeps its scroll position on rename'" }),
			description: Type.String({ description: "Markdown: what was wrong, what you changed, how you tested it" }),
			releaseNotes: Type.Array(Type.String(), {
				description: "User-facing release note bullets; empty when users won't notice the change",
			}),
		}),
		execute: async (args, _api) => {
			const issue = await host.issue();
			const title = pullRequestTitle(changeType(issue.labels, host.typeLabels), args.summary);
			const body = pullRequestBody(issue, args.description, args.releaseNotes);
			const found = leaks(`${title}\n${body}`, privateTokens(issue.privateNote));
			if (found.length > 0) refuseLeaks(found);
			const pr = await host.upsertPullRequest({ branch: issue.branchName, title, body, draft: host.draft(issue) });
			return { output: text(`Pull request #${pr.number}: ${pr.url}`) };
		},
	});

	const askMaintainer = defineTool({
		name: "ask_maintainer",
		description:
			"Ask the maintainer a question you can't settle from the issue, the code or the tests, and stop until they answer. Say what you found first.",
		parameters: Type.Object({ question: Type.String() }),
		execute: async (args) => {
			await host.ask(args.question);
			return { output: text("Asked. Their answer arrives as a new message."), control: { terminate: true } };
		},
	});

	return defineExtension({ name: "notefig.tools", tools: [push, openPullRequest, askMaintainer] });
}
