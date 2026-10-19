/**
 * Everything that differs between accounts, read from `wrangler.jsonc` vars and secrets. Names, not ids: the Linear
 * team, labels and approvers are looked up by name or email, so moving to another workspace is a config edit.
 */

export interface Env {
	ISSUE_AGENT: DurableObjectNamespace<import("./issue-agent.ts").IssueAgent>;
	/** Branch name → Linear issue id, so a GitHub event finds its agent. */
	BRANCHES: KVNamespace;

	GITHUB_REPO: string;
	LINEAR_TEAM_KEY: string;
	/** While set, only issues with this label start an agent. Empty: any accepted issue. */
	LINEAR_TEST_LABEL: string;
	/** Comma-separated emails of the people whose delegation starts an agent. */
	APPROVER_EMAILS: string;
	/** Comma-separated GitHub logins, besides collaborators, whose reviews reach the agent (e.g. a review bot). */
	TRUSTED_REVIEWERS: string;
	/** `Label=type` pairs, comma-separated: the issue label that sets the commit and PR type. */
	TYPE_LABELS: string;
	MODEL_PROVIDER: string;
	MODEL_ID: string;
	AI_GATEWAY_ID: string;
	CLOUDFLARE_ACCOUNT_ID: string;
	/** Who the agent's commits are by: the GitHub App's bot user, so GitHub shows its avatar. */
	GIT_AUTHOR_NAME: string;
	GIT_AUTHOR_EMAIL: string;

	// Secrets, synced from GitHub by the release workflow.
	LINEAR_CLIENT_ID: string;
	LINEAR_CLIENT_SECRET: string;
	LINEAR_WEBHOOK_SECRET: string;
	GH_APP_ID: string;
	GH_APP_PRIVATE_KEY: string;
	GH_APP_WEBHOOK_SECRET: string;
	AI_GATEWAY_TOKEN: string;
}

export interface Config {
	repo: { owner: string; name: string };
	teamKey: string;
	testLabel: string | undefined;
	approverEmails: readonly string[];
	trustedReviewers: readonly string[];
	typeLabels: ReadonlyMap<string, string>;
	model: { provider: string; modelId: string };
	gitAuthor: { name: string; email: string };
}

const list = (value: string | undefined) =>
	(value ?? "")
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);

export function readConfig(env: Env): Config {
	const [owner, name] = env.GITHUB_REPO.split("/");
	if (!owner || !name) throw new Error(`GITHUB_REPO must be owner/name, got "${env.GITHUB_REPO}"`);
	const typeLabels = new Map<string, string>();
	for (const pair of list(env.TYPE_LABELS)) {
		const [label, type] = pair.split("=").map((part) => part.trim());
		if (label && type) typeLabels.set(label.toLowerCase(), type);
	}
	return {
		repo: { owner, name },
		teamKey: env.LINEAR_TEAM_KEY,
		testLabel: env.LINEAR_TEST_LABEL.trim() || undefined,
		approverEmails: list(env.APPROVER_EMAILS).map((email) => email.toLowerCase()),
		trustedReviewers: list(env.TRUSTED_REVIEWERS).map((login) => login.toLowerCase()),
		typeLabels,
		model: { provider: env.MODEL_PROVIDER, modelId: env.MODEL_ID },
		gitAuthor: { name: env.GIT_AUTHOR_NAME, email: env.GIT_AUTHOR_EMAIL },
	};
}
