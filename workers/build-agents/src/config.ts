/**
 * Everything that differs between accounts, read from `wrangler.jsonc` vars and secrets. Names, not ids: the Linear
 * team, labels and approvers are looked up by name or email, so moving to another workspace is a config edit.
 */

export interface Env {
	ISSUE_AGENT: DurableObjectNamespace<import("./issue-agent.ts").IssueAgent>;
	/**
	 * Branch name → Linear issue id, so a GitHub event finds its agent; and `issueKey(id)` → branch name, so a Linear
	 * event about the issue (closed, deleted) knows it has one.
	 */
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
	/** The default model, for an issue without a whitelisted Model label. */
	MODEL_ID: string;
	/**
	 * `Label=modelId` pairs, comma-separated: the whitelist of models an issue's Model label can pick, all from
	 * `MODEL_PROVIDER`. A label not listed here picks nothing.
	 */
	MODEL_LABELS: string;
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

/** An issue's key in `BRANCHES`. A branch name can't hold a colon, so it never meets one. */
export function issueKey(issueId: string): string {
	return `issue:${issueId}`;
}

export interface Model {
	provider: string;
	modelId: string;
}

export interface Config {
	repo: { owner: string; name: string };
	teamKey: string;
	testLabel: string | undefined;
	approverEmails: readonly string[];
	trustedReviewers: readonly string[];
	typeLabels: ReadonlyMap<string, string>;
	/** The default model. */
	model: Model;
	/** The whitelist: lower-cased label → model id. */
	modelLabels: ReadonlyMap<string, string>;
	gitAuthor: { name: string; email: string };
}

const list = (value: string | undefined) =>
	(value ?? "")
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);

/** `Label=value` pairs, comma-separated, as a map from the lower-cased label. A pair missing either side is skipped. */
function labelMap(value: string | undefined): Map<string, string> {
	const map = new Map<string, string>();
	for (const pair of list(value)) {
		const at = pair.indexOf("=");
		const label = pair.slice(0, at).trim();
		const mapped = pair.slice(at + 1).trim();
		if (at > 0 && label && mapped) map.set(label.toLowerCase(), mapped);
	}
	return map;
}

export function readConfig(env: Env): Config {
	const [owner, name] = env.GITHUB_REPO.split("/");
	if (!owner || !name) throw new Error(`GITHUB_REPO must be owner/name, got "${env.GITHUB_REPO}"`);
	return {
		repo: { owner, name },
		teamKey: env.LINEAR_TEAM_KEY,
		testLabel: env.LINEAR_TEST_LABEL.trim() || undefined,
		approverEmails: list(env.APPROVER_EMAILS).map((email) => email.toLowerCase()),
		trustedReviewers: list(env.TRUSTED_REVIEWERS).map((login) => login.toLowerCase()),
		typeLabels: labelMap(env.TYPE_LABELS),
		model: { provider: env.MODEL_PROVIDER, modelId: env.MODEL_ID },
		modelLabels: labelMap(env.MODEL_LABELS),
		gitAuthor: { name: env.GIT_AUTHOR_NAME, email: env.GIT_AUTHOR_EMAIL },
	};
}

/**
 * The model for an issue: the one its first whitelisted label picks (and that label), or the default. Only whitelisted
 * ids ever reach the provider, so a label can't point an agent at any other model.
 */
export function modelFor(labels: readonly string[], config: Pick<Config, "model" | "modelLabels">): { model: Model; label?: string } {
	for (const label of labels) {
		const modelId = config.modelLabels.get(label.toLowerCase());
		if (modelId) return { model: { provider: config.model.provider, modelId }, label };
	}
	return { model: config.model };
}
