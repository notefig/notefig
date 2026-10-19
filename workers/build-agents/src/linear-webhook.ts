import type { Config } from "./config.ts";
import { signedBy } from "./signature.ts";

/**
 * Linear's agent session webhook, turned into what the issue's agent should do. Delegating an issue to the app, or
 * mentioning it, sends `created`; a message in the session sends `prompted`, and the session's stop button sends
 * `prompted` with the `stop` signal. Only approvers start or steer an agent.
 */

export type AgentCommand =
	| { kind: "start"; issueId: string; sessionId: string; prompt: string }
	| { kind: "steer"; issueId: string; sessionId: string; text: string; requestId: string }
	| { kind: "stop"; issueId: string; sessionId: string }
	/** The issue's delegate changed: if it was this app, its agent stops (`index.ts` knows the app's user id). */
	| { kind: "undelegated"; issueId: string; previousDelegateId: string };

export type WebhookOutcome =
	| { ok: false; status: number; error: string }
	| { ok: true; command: AgentCommand | undefined; reason?: string };

/** An `Issue` data webhook: only its delegate changing matters here. */
interface IssueEvent {
	type: "Issue";
	action: string;
	webhookTimestamp: number;
	data: { id: string; delegateId?: string | null };
	updatedFrom?: { delegateId?: string | null };
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
	let event: AgentSessionEvent | IssueEvent;
	try {
		event = JSON.parse(rawBody) as AgentSessionEvent | IssueEvent;
	} catch {
		return { ok: false, status: 400, error: "Body is not JSON" };
	}
	if (Math.abs(now - event.webhookTimestamp) > MAX_CLOCK_SKEW_MS) return { ok: false, status: 401, error: "Stale webhook" };
	if (event.type === "Issue") return undelegation(event as IssueEvent);
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
 * Unassigning an agent (removing it as the delegate, or delegating to someone else) stops it. Anyone may do that: it
 * only ever stops work. Whose delegation it was is checked by the caller.
 */
function undelegation(event: IssueEvent): WebhookOutcome {
	const previous = event.updatedFrom?.delegateId;
	if (event.action !== "update" || !previous || event.data.delegateId === previous) {
		return { ok: true, command: undefined, reason: "not an undelegation" };
	}
	return { ok: true, command: { kind: "undelegated", issueId: event.data.id, previousDelegateId: previous } };
}
