import type { Config } from "./config.ts";
import type { AppUser, IssueComment } from "./linear.ts";
import { signedBy } from "./signature.ts";

/**
 * Linear's agent session webhook, turned into what the issue's agent should do. Delegating an issue to the app, or
 * mentioning it, sends `created`; a message in the session sends `prompted`, and the session's stop button sends
 * `prompted` with the `stop` signal. A comment on the issue outside the session arrives as a `Comment` event. Only
 * approvers start or steer an agent.
 */

export type AgentCommand =
	| { kind: "start"; issueId: string; sessionId: string; prompt: string }
	| { kind: "steer"; issueId: string; sessionId: string; text: string; requestId: string }
	| { kind: "stop"; issueId: string; sessionId: string }
	/** The issue's delegate changed: if it was this app, its agent stops (`index.ts` knows the app's user id). */
	| { kind: "undelegated"; issueId: string; previousDelegateId: string }
	/**
	 * The issue was closed (done or cancelled) or deleted. `index.ts` passes it on only if the issue has an agent, so a
	 * closed issue doesn't wake an object of its own.
	 */
	| { kind: "ended"; issueId: string; why: IssueEnd; delegateId: string | null }
	/** A comment on the issue: whether it's for the agent is decided once it's fetched (`commentForAgent`). */
	| { kind: "comment"; issueId: string; commentId: string };

export type WebhookOutcome =
	| { ok: false; status: number; error: string }
	| { ok: true; command: AgentCommand | undefined; reason?: string };

export type IssueEnd = "completed" | "canceled" | "deleted";

/** An `Issue` data webhook: only its delegate changing, and the issue closing or going away, matter here. */
interface IssueEvent {
	type: "Issue";
	action: string;
	webhookTimestamp: number;
	data: { id: string; delegateId?: string | null; state?: { type: string }; trashed?: boolean | null };
	updatedFrom?: { delegateId?: string | null; stateId?: string; trashed?: boolean | null };
}

/** A `Comment` data webhook. A comment by an integration or a bot has no `userId`. */
interface CommentEvent {
	type: "Comment";
	action: string;
	webhookTimestamp: number;
	data: { id: string; issueId?: string | null; userId?: string | null };
}

interface AgentSessionEvent {
	type: string;
	action: string;
	webhookTimestamp: number;
	promptContext?: string;
	agentSession: {
		id: string;
		issueId?: string;
		issue?: { id: string };
		creator?: { email?: string };
	};
	agentActivity?: { id: string; signal?: string; content?: { body?: string }; user?: { email?: string } };
}

const MAX_CLOCK_SKEW_MS = 60_000;

export async function readLinearWebhook(
	rawBody: string,
	signature: string | null,
	secret: string,
	config: Config,
	now: number,
): Promise<WebhookOutcome> {
	if (!(await signedBy(secret, rawBody, signature))) return { ok: false, status: 401, error: "Bad signature" };
	let event: AgentSessionEvent | IssueEvent | CommentEvent;
	try {
		event = JSON.parse(rawBody) as AgentSessionEvent | IssueEvent | CommentEvent;
	} catch {
		return { ok: false, status: 400, error: "Body is not JSON" };
	}
	if (Math.abs(now - event.webhookTimestamp) > MAX_CLOCK_SKEW_MS) return { ok: false, status: 401, error: "Stale webhook" };
	if (event.type === "Issue") return issueChange(event as IssueEvent);
	if (event.type === "Comment") return comment(event as CommentEvent);
	if (event.type !== "AgentSessionEvent") return { ok: true, command: undefined, reason: "not an agent session event" };

	const session = (event as AgentSessionEvent).agentSession;
	const issueId = session.issue?.id ?? session.issueId;
	if (!issueId) return { ok: true, command: undefined, reason: "session has no issue" };
	// Without its session the agent would work without being able to say anything.
	if (!session.id) return { ok: false, status: 400, error: "Agent session has no id" };
	const approved = (email: string | undefined) => email !== undefined && config.approverEmails.includes(email.toLowerCase());

	if (event.action === "created") {
		const agentEvent = event as AgentSessionEvent;
		// The agent checks the issue itself (Triage, the test label) once it has fetched it.
		if (!approved(session.creator?.email)) return { ok: true, command: undefined, reason: "not started by an approver" };
		return { ok: true, command: { kind: "start", issueId, sessionId: session.id, prompt: agentEvent.promptContext ?? "" } };
	}

	const agentEvent = event as AgentSessionEvent;
	if (agentEvent.action === "prompted" && agentEvent.agentActivity) {
		const activity = agentEvent.agentActivity;
		if (!approved(activity.user?.email)) return { ok: true, command: undefined, reason: "not from an approver" };
		if (activity.signal === "stop") return { ok: true, command: { kind: "stop", issueId, sessionId: session.id } };
		const text = activity.content?.body?.trim();
		if (!text) return { ok: true, command: undefined, reason: "empty message" };
		return { ok: true, command: { kind: "steer", issueId, sessionId: session.id, text, requestId: `linear:${activity.id}` } };
	}

	return { ok: true, command: undefined, reason: `action ${event.action}` };
}

/**
 * Unassigning an agent (removing it as the delegate, or delegating to someone else) stops it, and so does its issue
 * being marked done, cancelled (a duplicate is a cancelled state too) or deleted. Anyone may do either: it only ever
 * stops work. Whose issue it was is checked by the caller.
 */
function issueChange(event: IssueEvent): WebhookOutcome {
	const { data, updatedFrom } = event;
	if (!data?.id) return { ok: true, command: undefined, reason: "issue event without an issue" };
	const ended = (why: IssueEnd): WebhookOutcome => ({
		ok: true,
		command: { kind: "ended", issueId: data.id, why, delegateId: data.delegateId ?? null },
	});
	// Deleting moves an issue to the trash (an update); deleting it for good, or straight away, is a `remove`.
	if (event.action === "remove" || (event.action === "update" && data.trashed && !updatedFrom?.trashed)) return ended("deleted");
	if (event.action !== "update") return { ok: true, command: undefined, reason: "not an issue update" };
	const state = data.state?.type;
	if (updatedFrom?.stateId !== undefined && (state === "completed" || state === "canceled")) return ended(state);
	const previous = updatedFrom?.delegateId;
	if (!previous || data.delegateId === previous) return { ok: true, command: undefined, reason: "not an undelegation or an end" };
	return { ok: true, command: { kind: "undelegated", issueId: data.id, previousDelegateId: previous } };
}

function comment(event: CommentEvent): WebhookOutcome {
	const { id, issueId, userId } = event.data;
	if (event.action !== "create" || !issueId || !userId) return { ok: true, command: undefined, reason: "not a person's new comment on an issue" };
	return { ok: true, command: { kind: "comment", issueId, commentId: id } };
}

/**
 * Whether a comment on an issue is feedback for its agent: an approver's, on an issue delegated to the app, and not
 * already on its way. A comment in an agent session's thread arrives as `prompted`, and one mentioning the app opens a
 * session of its own, so both are left to those. Undefined when it's for the agent, else why not.
 */
export function commentForAgent(comment: IssueComment, app: AppUser, config: Pick<Config, "approverEmails">): string | undefined {
	if (comment.issue?.delegateId !== app.id) return "issue not delegated to the agent";
	if (!comment.author || !config.approverEmails.includes(comment.author.email.toLowerCase())) return "not from an approver";
	if (comment.inAgentThread) return "in an agent session's thread";
	if (mentions(comment.body, app)) return "mentions the agent";
	if (!comment.body.trim()) return "empty comment";
	return undefined;
}

/** A mention of the app: a link to its profile, or `@` and its name as a whole word. Code that quotes either isn't one. */
function mentions(body: string, app: AppUser): boolean {
	const prose = body.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
	const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`${escape(app.url)}(?![\\w/-])|@${escape(app.displayName)}(?![\\w-])`, "i").test(prose);
}
