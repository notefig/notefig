import type { IssueSummary } from "./git-output.ts";

/**
 * Linear, as the agent's own app: an app-actor token from the client credentials grant (valid 30 days, minted again on
 * a 401), agent activities on the session, and the issue it works on. Plain GraphQL over `fetch`, no SDK.
 */

const API = "https://api.linear.app/graphql";
const TOKEN_URL = "https://api.linear.app/oauth/token";
const SCOPES = "read,write,app:assignable,app:mentionable";

/** What the agent says on its session. Linear sets the session's state from the last one. */
export type Activity =
	| { type: "thought" | "elicitation" | "response" | "error"; body: string }
	| { type: "action"; action: string; parameter: string; result?: string };

export interface IssueDetails extends IssueSummary {
	description: string;
	teamKey: string;
	stateType: string;
	/** The team's first "started" state (In Progress), which the agent moves the issue to when it starts. */
	startedStateId: string | undefined;
	/** The top-level comment the support Worker wrote with the debug report and screenshots, kept out of GitHub. */
	privateNote: string | undefined;
}

export interface LinearAgentClient {
	activity(sessionId: string, activity: Activity, options?: { ephemeral?: boolean }): Promise<void>;
	addLink(sessionId: string, label: string, url: string): Promise<void>;
	issue(issueId: string): Promise<IssueDetails>;
	/** Moves the issue to a state. */
	moveIssue(issueId: string, stateId: string): Promise<void>;
	/** The app's own Linear user: the delegate of every issue handed to it, and what a mention of it links to. */
	appUser(): Promise<AppUser>;
	/** A comment on an issue, with what decides whether it's for the agent working on that issue. */
	comment(commentId: string): Promise<IssueComment>;
}

export interface AppUser {
	id: string;
	/** The user's profile page, which a mention in markdown links to. */
	url: string;
	displayName: string;
}

export interface IssueComment {
	id: string;
	body: string;
	/** Null for a comment by an integration (one synced from GitHub, say) or a bot. */
	author: { name: string; email: string } | null;
	/** The comment opens an agent session (one that mentions an agent), or replies in one's thread. */
	inAgentThread: boolean;
	issue: { id: string; delegateId: string | undefined } | undefined;
}

export interface LinearCredentials {
	clientId: string;
	clientSecret: string;
}

/** The support Worker's private note starts with this line; see `workers/support/src/feedback.ts`. */
export const PRIVATE_NOTE_MARKER = "_Private: comments outside the synced thread stay out of GitHub._";

let cached: { key: string; token: string } | undefined;
let cachedViewer: { key: string; user: AppUser } | undefined;

export function linearAgentClient(credentials: LinearCredentials, fetchFn: typeof fetch = fetch): LinearAgentClient {
	const key = credentials.clientId;

	async function token(fresh = false): Promise<string> {
		if (!fresh && cached?.key === key) return cached.token;
		const response = await fetchFn(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "client_credentials",
				scope: SCOPES,
				client_id: credentials.clientId,
				client_secret: credentials.clientSecret,
			}),
		});
		if (!response.ok) throw new Error(`Linear token failed (${response.status}): ${await response.text()}`);
		const { access_token } = (await response.json()) as { access_token: string };
		cached = { key, token: access_token };
		return access_token;
	}

	async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
		const send = async (bearer: string) =>
			fetchFn(API, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
				body: JSON.stringify({ query, variables }),
			});
		let response = await send(await token());
		if (response.status === 401) response = await send(await token(true));
		const result = (await response.json()) as { data?: T; errors?: { message: string }[] };
		if (!response.ok || result.errors?.length || !result.data) {
			throw new Error(`Linear: ${result.errors?.map((error) => error.message).join("; ") ?? response.status}`);
		}
		return result.data;
	}

	return {
		async activity(sessionId, activity, options) {
			await graphql(
				`mutation ($input: AgentActivityCreateInput!) { agentActivityCreate(input: $input) { success } }`,
				{ input: { agentSessionId: sessionId, content: activity, ...(options?.ephemeral ? { ephemeral: true } : {}) } },
			);
		},
		async addLink(sessionId, label, url) {
			await graphql(
				`mutation ($id: String!, $input: AgentSessionUpdateInput!) { agentSessionUpdate(id: $id, input: $input) { success } }`,
				{ id: sessionId, input: { addedExternalUrls: [{ label, url }] } },
			);
		},
		async moveIssue(issueId, stateId) {
			await graphql(`mutation ($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`, {
				id: issueId,
				input: { stateId },
			});
		},
		async appUser() {
			if (cachedViewer?.key === key) return cachedViewer.user;
			const { viewer } = await graphql<{ viewer: AppUser }>(`{ viewer { id url displayName } }`, {});
			cachedViewer = { key, user: viewer };
			return viewer;
		},
		async comment(commentId) {
			const { comment } = await graphql<{ comment: RawComment }>(COMMENT_QUERY, { id: commentId });
			return {
				id: comment.id,
				body: comment.body,
				author: comment.user,
				inAgentThread: Boolean(comment.agentSession || comment.parent?.agentSession),
				issue: comment.issue ? { id: comment.issue.id, delegateId: comment.issue.delegate?.id } : undefined,
			};
		},
		async issue(issueId) {
			const { issue } = await graphql<{ issue: RawIssue }>(ISSUE_QUERY, { id: issueId });
			return toIssueDetails(issue);
		},
	};
}

const ISSUE_QUERY = `query ($id: String!) {
	issue(id: $id) {
		id identifier title url branchName description
		team { key states(filter: { type: { eq: "started" } }) { nodes { id position } } }
		state { type }
		labels { nodes { name } }
		comments(first: 50) { nodes { body parent { id } } }
	}
}`;

const COMMENT_QUERY = `query ($id: String!) {
	comment(id: $id) {
		id body
		user { name email }
		agentSession { id }
		parent { agentSession { id } }
		issue { id delegate { id } }
	}
}`;

interface RawComment {
	id: string;
	body: string;
	user: { name: string; email: string } | null;
	agentSession: { id: string } | null;
	parent: { agentSession: { id: string } | null } | null;
	issue: { id: string; delegate: { id: string } | null } | null;
}

interface RawIssue {
	id: string;
	identifier: string;
	title: string;
	url: string;
	branchName: string;
	description: string | null;
	team: { key: string; states: { nodes: { id: string; position: number }[] } };
	state: { type: string };
	labels: { nodes: { name: string }[] };
	comments: { nodes: { body: string; parent: { id: string } | null }[] };
}

export function toIssueDetails(issue: RawIssue): IssueDetails {
	const note = issue.comments.nodes.find((comment) => !comment.parent && comment.body.startsWith(PRIVATE_NOTE_MARKER));
	return {
		id: issue.id,
		identifier: issue.identifier,
		title: issue.title,
		url: issue.url,
		branchName: issue.branchName,
		description: issue.description ?? "",
		teamKey: issue.team.key,
		stateType: issue.state.type,
		startedStateId: [...issue.team.states.nodes].sort((a, b) => a.position - b.position)[0]?.id,
		labels: issue.labels.nodes.map((label) => label.name),
		privateNote: note?.body,
	};
}
