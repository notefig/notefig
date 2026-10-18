import { json } from "./http.ts";
import type { CreateComment } from "./linear.ts";

/**
 * `POST /v1/linear`: Linear's webhook. When an approver assigns an accepted
 * issue (out of Triage) to the agent account, this fires a Claude Code
 * routine to implement it, then leaves a comment on the issue linking the
 * run. The routine's own prompt says what to do with the issue; what's sent
 * here is only the issue, which the routine treats as untrusted data.
 *
 * Server to server, so there's no Origin to check: Linear's HMAC signature
 * over the raw body is the guard, with its timestamp bounding replays.
 */

export interface AgentTriggerConfig {
  webhookSecret: string;
  agentUserId: string;
  approverIds: readonly string[];
  triageStateId: string;
  routineFireUrl: string;
  routineToken: string;
}

export interface AgentTriggerDeps {
  config: AgentTriggerConfig;
  fetchFn: typeof fetch;
  createComment: CreateComment;
  now: () => number;
}

const MAX_CLOCK_SKEW_MS = 60_000;

interface IssueEvent {
  action: string;
  type: string;
  webhookTimestamp: number;
  actor?: { id: string };
  data: {
    id: string;
    identifier: string;
    title: string;
    description?: string | null;
    url: string;
    assigneeId?: string | null;
    stateId: string;
  };
  updatedFrom?: Record<string, unknown>;
}

export async function handleLinearWebhook(
  rawBody: string,
  signature: string | null,
  deps: AgentTriggerDeps,
): Promise<Response> {
  if (!(await signedBy(deps.config.webhookSecret, rawBody, signature))) {
    return json(401, { error: "Bad signature" });
  }
  let event: IssueEvent;
  try {
    event = JSON.parse(rawBody) as IssueEvent;
  } catch {
    return json(400, { error: "Body is not JSON" });
  }
  if (Math.abs(deps.now() - event.webhookTimestamp) > MAX_CLOCK_SKEW_MS) {
    return json(401, { error: "Stale webhook" });
  }
  if (!asksForAgent(event, deps.config)) return json(200, { outcome: "ignored" });

  let run: { claude_code_session_url?: string };
  try {
    run = await fireRoutine(event, deps);
  } catch (error) {
    // Linear retries a failed delivery, which retries the fire.
    console.error("agent trigger: routine not fired", error);
    return json(502, { error: "Could not start the agent" });
  }
  // The agent is running either way; a missing comment only costs the link.
  await deps
    .createComment(
      event.data.id,
      `Agent started${run.claude_code_session_url ? `: ${run.claude_code_session_url}` : "."} It will link its pull request here.`,
    )
    .catch((error: unknown) => console.error("agent trigger: comment not added", error));
  return json(200, { outcome: "started" });
}

/**
 * An approver gave an accepted issue to the agent: it was assigned to the
 * agent account just now (or created assigned to it), by someone on the
 * approver list, and it's no longer in Triage.
 */
function asksForAgent(event: IssueEvent, config: AgentTriggerConfig): boolean {
  if (event.type !== "Issue") return false;
  const assignedNow =
    event.action === "create" ||
    (event.action === "update" && event.updatedFrom !== undefined && "assigneeId" in event.updatedFrom);
  return (
    assignedNow &&
    event.data.assigneeId === config.agentUserId &&
    config.approverIds.includes(event.actor?.id ?? "") &&
    event.data.stateId !== config.triageStateId
  );
}

async function fireRoutine(
  event: IssueEvent,
  { config, fetchFn }: AgentTriggerDeps,
): Promise<{ claude_code_session_url?: string }> {
  const { id, identifier, title, url, description } = event.data;
  const text = [
    `Linear issue ${identifier} (id ${id})`,
    `Title: ${title}`,
    `URL: ${url}`,
    "",
    "Description:",
    description?.trim() || "(none)",
  ].join("\n");
  const response = await fetchFn(config.routineFireUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.routineToken}`,
      "anthropic-beta": "experimental-cc-routine-2026-04-01",
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
  });
  if (!response.ok) throw new Error(`routine fire failed (${response.status}): ${await response.text()}`);
  return (await response.json().catch(() => ({}))) as { claude_code_session_url?: string };
}

/** Linear's `Linear-Signature`: the hex HMAC-SHA256 of the raw body. */
async function signedBy(secret: string, body: string, signature: string | null): Promise<boolean> {
  if (!signature) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const bytes = hexToBytes(signature);
  return bytes !== null && crypto.subtle.verify("HMAC", key, bytes, new TextEncoder().encode(body));
}

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) return null;
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16));
}
