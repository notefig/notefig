/**
 * GitHub, as the agent's own GitHub App: a JWT signed with the app's private key (WebCrypto, RS256) buys a one-hour
 * installation token for the one repository. The token never enters the container; the git gateway adds it to the
 * container's requests, and pull requests are opened from here.
 */

const API = "https://api.github.com";

export interface GitHubAppCredentials {
	appId: string;
	/** PEM, PKCS#8 (`BEGIN PRIVATE KEY`) or PKCS#1 (`BEGIN RSA PRIVATE KEY`, what GitHub hands out). */
	privateKey: string;
}

export interface PullRequest {
	number: number;
	url: string;
}

export interface FailedJob {
	name: string;
	steps: string[];
	url: string;
	/** The end of the job's log, where the failure is: the agent can't read CI logs itself. */
	logTail: string;
}

const LOG_TAIL_LINES = 60;

/** The last lines of a job log, without GitHub's timestamps and colour codes. */
export function logTail(log: string, lines = LOG_TAIL_LINES): string {
	return log
		.split("\n")
		.map((line) => line.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, "").replace(/\x1b\[[0-9;]*m/g, ""))
		.filter((line) => line.trim() && !line.startsWith("##[group]") && !line.startsWith("##[endgroup]"))
		.slice(-lines)
		.join("\n");
}

export interface GitHubClient {
	/** A token for git over HTTPS and the REST API, cached until shortly before it expires. */
	token(): Promise<string>;
	/** Opens the pull request for `branch`, or updates the open one. */
	upsertPullRequest(input: { branch: string; title: string; body: string; draft: boolean }): Promise<PullRequest>;
	/** Whether `login` can push to the repository (write, maintain or admin): someone whose review the agent follows. */
	canWrite(login: string): Promise<boolean>;
	failedJobs(runId: number): Promise<FailedJob[]>;
}

let cached: { key: string; token: string; expiresAt: number } | undefined;

export function gitHubClient(
	credentials: GitHubAppCredentials,
	repo: { owner: string; name: string },
	fetchFn: typeof fetch = fetch,
	now: () => number = Date.now,
): GitHubClient {
	const key = `${credentials.appId}/${repo.owner}/${repo.name}`;
	const repoPath = `/repos/${repo.owner}/${repo.name}`;

	async function request<T>(path: string, init: RequestInit & { bearer: string }): Promise<{ status: number; body: T }> {
		const { bearer, ...rest } = init;
		const response = await fetchFn(`${API}${path}`, {
			...rest,
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${bearer}`,
				"User-Agent": "notefig-build-agents",
				"X-GitHub-Api-Version": "2022-11-28",
				...(rest.body ? { "Content-Type": "application/json" } : {}),
			},
		});
		const text = await response.text();
		const body = (text ? JSON.parse(text) : undefined) as T;
		if (!response.ok && response.status !== 404) throw new Error(`GitHub ${path} (${response.status}): ${text}`);
		return { status: response.status, body };
	}

	async function token(): Promise<string> {
		if (cached?.key === key && cached.expiresAt - now() > 5 * 60_000) return cached.token;
		const jwt = await appJwt(credentials, now());
		const installation = await request<{ id: number }>(`${repoPath}/installation`, { bearer: jwt });
		if (installation.status === 404) throw new Error(`The GitHub App is not installed on ${repo.owner}/${repo.name}`);
		const issued = await request<{ token: string; expires_at: string }>(
			`/app/installations/${installation.body.id}/access_tokens`,
			{
				bearer: jwt,
				method: "POST",
				body: JSON.stringify({
					repositories: [repo.name],
					permissions: { contents: "write", pull_requests: "write", actions: "read", checks: "read" },
				}),
			},
		);
		cached = { key, token: issued.body.token, expiresAt: Date.parse(issued.body.expires_at) };
		return issued.body.token;
	}

	return {
		token,
		async upsertPullRequest({ branch, title, body, draft }) {
			const bearer = await token();
			const open = await request<{ number: number; html_url: string }[]>(
				`${repoPath}/pulls?state=open&head=${encodeURIComponent(`${repo.owner}:${branch}`)}`,
				{ bearer },
			);
			const existing = open.body[0];
			if (existing) {
				await request(`${repoPath}/pulls/${existing.number}`, { bearer, method: "PATCH", body: JSON.stringify({ title, body }) });
				return { number: existing.number, url: existing.html_url };
			}
			const created = await request<{ number: number; html_url: string }>(`${repoPath}/pulls`, {
				bearer,
				method: "POST",
				body: JSON.stringify({ title, body, head: branch, base: "main", draft }),
			});
			return { number: created.body.number, url: created.body.html_url };
		},
		async canWrite(login) {
			// The permission endpoint works with an app's metadata access; the plain collaborator check answers 404.
			const { status, body } = await request<{ permission?: string }>(
				`${repoPath}/collaborators/${encodeURIComponent(login)}/permission`,
				{ bearer: await token() },
			);
			return status === 200 && ["admin", "maintain", "write"].includes(body?.permission ?? "");
		},
		async failedJobs(runId) {
			const bearer = await token();
			const { body } = await request<{
				jobs: { id: number; name: string; conclusion: string | null; html_url: string; steps?: { name: string; conclusion: string | null }[] }[];
			}>(`${repoPath}/actions/runs/${runId}/jobs?filter=latest`, { bearer });
			const failed = body.jobs.filter((job) => job.conclusion === "failure");
			return Promise.all(
				failed.map(async (job) => {
					// Redirects to a signed log URL; fetch drops the Authorization header on the way.
					const log = await fetchFn(`${API}${repoPath}/actions/jobs/${job.id}/logs`, {
						headers: { Authorization: `Bearer ${bearer}`, "User-Agent": "notefig-build-agents" },
					})
						.then((response) => (response.ok ? response.text() : ""))
						.catch(() => "");
					return {
						name: job.name,
						url: job.html_url,
						steps: (job.steps ?? []).filter((step) => step.conclusion === "failure").map((step) => step.name),
						logTail: logTail(log),
					};
				}),
			);
		},
	};
}

/** The app's JWT: issued a minute in the past for clock drift, valid nine minutes (GitHub allows ten). */
export async function appJwt(credentials: GitHubAppCredentials, nowMs: number): Promise<string> {
	const seconds = Math.floor(nowMs / 1000);
	const encode = (value: object) => base64Url(new TextEncoder().encode(JSON.stringify(value)));
	const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: seconds - 60, exp: seconds + 540, iss: credentials.appId })}`;
	const key = await crypto.subtle.importKey(
		"pkcs8",
		pkcs8(credentials.privateKey),
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
	return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
}

function base64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** PKCS#8 DER from a PEM key; a PKCS#1 RSA key is wrapped in the PKCS#8 structure WebCrypto imports. */
export function pkcs8(pem: string): Uint8Array {
	const rsa = pem.includes("BEGIN RSA PRIVATE KEY");
	const der = Uint8Array.from(
		atob(pem.replace(/-----(BEGIN|END)[A-Z ]+-----/g, "").replace(/\s+/g, "")),
		(char) => char.charCodeAt(0),
	);
	if (!rsa) return der;
	// SEQUENCE { INTEGER 0, SEQUENCE { OID rsaEncryption, NULL }, OCTET STRING { <PKCS#1 key> } }
	const algorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
	const body = [0x02, 0x01, 0x00, ...algorithm, 0x04, ...derLength(der.length), ...der];
	return Uint8Array.from([0x30, ...derLength(body.length), ...body]);
}

function derLength(length: number): number[] {
	if (length < 0x80) return [length];
	const bytes: number[] = [];
	for (let rest = length; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
	return [0x80 | bytes.length, ...bytes];
}
