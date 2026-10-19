/**
 * Makes the accounts match `wrangler.jsonc`, and changes nothing when they already do. Run it after editing the vars,
 * when moving to other accounts, and from the release workflow (which skips the GitHub part).
 *
 *   node --experimental-strip-types scripts/bootstrap.ts [--github] [--linear] [--gateway]   (default: all three)
 *
 * - GitHub (`gh` logged in as a repo admin): `main` requires pull requests and passing checks, can't be force-pushed
 *   or deleted. Repo admins and GitHub Actions (the release workflows' version bumps) bypass that; the agent's app
 *   can push its own branches, never `main`.
 * - Linear (LINEAR_CLIENT_ID, LINEAR_CLIENT_SECRET): the team exists, the test and type labels exist on it, and the
 *   approvers are members. Prints the link that installs the app as a delegatable agent.
 * - AI Gateway (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID): the gateway the agent's model calls go through exists.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const vars = readVars();

/** The `vars` of wrangler.jsonc. Comments are stripped; values have no `//` in them. */
function readVars(): Record<string, string> {
	const text = readFileSync(`${root}/wrangler.jsonc`, "utf8").replace(/^\s*\/\/.*$/gm, "");
	return JSON.parse(text).vars;
}

function env(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Set ${name}`);
	return value;
}

const list = (value: string | undefined) => (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);

// ── GitHub ──────────────────────────────────────────────────────────────────────────────────────────────────────

const RULESET_NAME = "Protect main";
/** The checks every pull request to main must pass. Matrix jobs report one check per entry. */
const REQUIRED_CHECKS = [
	"Test CLI",
	"Test Git Package",
	"Test Desktop (Unit)",
	"Test Desktop (Tauri) (macos-latest)",
	"Test Desktop (Tauri) (windows-latest)",
	"Test Build Agents",
];
const GITHUB_ACTIONS_APP = 15368;
const REPOSITORY_ADMIN_ROLE = 5;

function gh(args: string[], input?: unknown): unknown {
	const output = execFileSync("gh", ["api", ...args, ...(input ? ["--input", "-"] : [])], {
		encoding: "utf8",
		input: input ? JSON.stringify(input) : undefined,
	});
	return output.trim() ? JSON.parse(output) : undefined;
}

async function github() {
	const repo = vars.GITHUB_REPO;
	const ruleset = {
		name: RULESET_NAME,
		target: "branch",
		enforcement: "active",
		conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
		bypass_actors: [
			{ actor_id: REPOSITORY_ADMIN_ROLE, actor_type: "RepositoryRole", bypass_mode: "always" },
			// The release workflows push their version bumps to main with the Actions token.
			{ actor_id: GITHUB_ACTIONS_APP, actor_type: "Integration", bypass_mode: "always" },
		],
		rules: [
			{ type: "deletion" },
			{ type: "non_fast_forward" },
			{
				type: "pull_request",
				parameters: {
					required_approving_review_count: 0,
					dismiss_stale_reviews_on_push: false,
					require_code_owner_review: false,
					require_last_push_approval: false,
					required_review_thread_resolution: false,
				},
			},
			{
				type: "required_status_checks",
				parameters: {
					strict_required_status_checks_policy: true,
					do_not_enforce_on_create: true,
					required_status_checks: REQUIRED_CHECKS.map((context) => ({ context, integration_id: GITHUB_ACTIONS_APP })),
				},
			},
		],
	};
	// Only this script's own ruleset is created or updated; other rulesets on the repository are left as they are.
	const existing = (gh([`repos/${repo}/rulesets`]) as { id: number; name: string }[]).find((item) => item.name === RULESET_NAME);
	if (existing) gh(["-X", "PUT", `repos/${repo}/rulesets/${existing.id}`], ruleset);
	else gh(["-X", "POST", `repos/${repo}/rulesets`], ruleset);
	console.log(`GitHub: "${RULESET_NAME}" is active on ${repo}'s default branch.`);
}

/** The callback the Linear app registers; the Worker answers it with a page saying the install worked. */
const LINEAR_CALLBACK = "https://agents.notefig.com/v1/linear/installed";

// ── Linear ──────────────────────────────────────────────────────────────────────────────────────────────────────

async function linear() {
	const tokenResponse = await fetch("https://api.linear.app/oauth/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "client_credentials",
			scope: "read,write,app:assignable,app:mentionable",
			client_id: env("LINEAR_CLIENT_ID"),
			client_secret: env("LINEAR_CLIENT_SECRET"),
		}),
	});
	if (!tokenResponse.ok) throw new Error(`Linear token (${tokenResponse.status}): ${await tokenResponse.text()}`);
	const { access_token } = (await tokenResponse.json()) as { access_token: string };
	const query = async <T>(text: string, variables: Record<string, unknown> = {}): Promise<T> => {
		const response = await fetch("https://api.linear.app/graphql", {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${access_token}` },
			body: JSON.stringify({ query: text, variables }),
		});
		const result = (await response.json()) as { data?: T; errors?: { message: string }[] };
		if (result.errors?.length || !result.data) throw new Error(`Linear: ${result.errors?.map((e) => e.message).join("; ")}`);
		return result.data;
	};

	const { teams } = await query<{ teams: { nodes: { id: string; key: string; labels: { nodes: { name: string }[] } }[] } }>(
		`query ($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id key labels(first: 250) { nodes { name } } } } }`,
		{ key: vars.LINEAR_TEAM_KEY },
	);
	const team = teams.nodes[0];
	if (!team) throw new Error(`Linear: no team with key ${vars.LINEAR_TEAM_KEY}, or the app has no access to it`);

	const { issueLabels } = await query<{ issueLabels: { nodes: { name: string }[] } }>(
		`{ issueLabels(first: 250, filter: { team: { null: true } }) { nodes { name } } }`,
	);
	const known = new Set([...team.labels.nodes, ...issueLabels.nodes].map((label) => label.name.toLowerCase()));
	const wanted = [vars.LINEAR_TEST_LABEL, ...list(vars.TYPE_LABELS).map((pair) => pair.split("=")[0])].filter(Boolean);
	for (const name of wanted) {
		if (known.has(name.toLowerCase())) continue;
		await query(`mutation ($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { success } }`, {
			input: { name, teamId: team.id },
		});
		console.log(`Linear: created the "${name}" label on ${team.key}.`);
	}

	const approvers = list(process.env.APPROVER_EMAILS ?? vars.APPROVER_EMAILS);
	for (const email of approvers) {
		const { users } = await query<{ users: { nodes: { id: string }[] } }>(
			`query ($email: String!) { users(filter: { email: { eq: $email } }) { nodes { id } } }`,
			{ email },
		);
		if (users.nodes.length === 0) throw new Error(`Linear: no member with the approver email ${email}`);
	}
	if (approvers.length === 0) console.warn("Linear: no approvers set (APPROVER_EMAILS); nobody can start an agent.");

	const install = new URL("https://linear.app/oauth/authorize");
	install.search = new URLSearchParams({
		client_id: env("LINEAR_CLIENT_ID"),
		redirect_uri: LINEAR_CALLBACK,
		response_type: "code",
		scope: "read,write,app:assignable,app:mentionable",
		actor: "app",
	}).toString();
	console.log(`Linear: ${team.key} is ready. If the agent can't be delegated issues yet, install it once (admin): ${install}`);
}

// ── AI Gateway ──────────────────────────────────────────────────────────────────────────────────────────────────

async function gateway() {
	const account = env("CLOUDFLARE_ACCOUNT_ID");
	const base = `https://api.cloudflare.com/client/v4/accounts/${account}/ai-gateway/gateways`;
	const headers = { Authorization: `Bearer ${env("CLOUDFLARE_API_TOKEN")}`, "Content-Type": "application/json" };
	const id = vars.AI_GATEWAY_ID;
	const found = await fetch(`${base}/${id}`, { headers });
	if (found.ok) {
		console.log(`AI Gateway: ${id} exists.`);
		return;
	}
	const created = await fetch(base, {
		method: "POST",
		headers,
		body: JSON.stringify({
			id,
			collect_logs: true,
			cache_invalidate_on_update: false,
			cache_ttl: 0,
			rate_limiting_interval: 0,
			rate_limiting_limit: 0,
			rate_limiting_technique: "fixed",
		}),
	});
	if (!created.ok) throw new Error(`AI Gateway (${created.status}): ${await created.text()}`);
	console.log(`AI Gateway: created ${id}. Add a provider key or turn on unified billing in its dashboard.`);
}

// ── Run ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// Last, so every constant above is initialized before a part uses it.

const requested = new Set(process.argv.slice(2).map((arg) => arg.replace(/^--/, "")));
const runs = (part: string) => requested.size === 0 || requested.has(part);

if (runs("github")) await github();
if (runs("linear")) await linear();
if (runs("gateway")) await gateway();
