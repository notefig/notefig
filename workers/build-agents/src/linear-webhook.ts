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
	| { kind: "stop"; issueId: string; sessionId: string };

export type WebhookOutcome =
	| { ok: false; status: number; error: string }
	| { ok: true; command: AgentCommand | undefined; reason?: string };

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
	let event: AgentSessionEvent;
	try {
		event = JSON.parse(rawBody) as AgentSessionEvent;
	} catch {
		return { ok: false, status: 400, error: "Body is not JSON" };
	}
	if (Math.abs(now - event.webhookTimestamp) > MAX_CLOCK_SKEW_MS) return { ok: false, status: 401, error: "Stale webhook" };
	if (event.type !== "AgentSessionEvent") return { ok: true, command: undefined, reason: "not an agent session event" };

	const session = event.agentSession;
	const issueId = session.issue?.id ?? session.issueId;
	if (!issueId) return { ok: true, command: undefined, reason: "session has no issue" };
	const approved = (email: string | undefined) => email !== undefined && config.approverEmails.includes(email.toLowerCase());

	if (event.action === "created") {
		// The agent checks the issue itself (Triage, the test label) once it has fetched it.
		if (!approved(session.creator?.email)) return { ok: true, command: undefined, reason: "not started by an approver" };
		return { ok: true, command: { kind: "start", issueId, sessionId: session.id, prompt: event.promptContext ?? "" } };
	}

	if (event.action === "prompted" && event.agentActivity) {
		const activity = event.agentActivity;
		if (!approved(activity.user?.email)) return { ok: true, command: undefined, reason: "not from an approver" };
		if (activity.signal === "stop") return { ok: true, command: { kind: "stop", issueId, sessionId: session.id } };
		const text = activity.content?.body?.trim();
		if (!text) return { ok: true, command: undefined, reason: "empty message" };
		return { ok: true, command: { kind: "steer", issueId, sessionId: session.id, text, requestId: `linear:${activity.id}` } };
	}

	return { ok: true, command: undefined, reason: `action ${event.action}` };
}
