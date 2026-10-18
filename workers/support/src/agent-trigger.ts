import type Anthropic from "@anthropic-ai/sdk";
import { json } from "./http.ts";
import type { CreateComment, IssueComments } from "./linear.ts";

/**
 * `POST /v1/linear`: Linear's webhook. When an approver assigns an accepted
 * issue (out of Triage) to the agent account, this starts a Claude Managed
 * Agents session to implement it, then comments on the issue with a link
 * to the session. The agent's rules live in its definition
 * (`agents/feedback-builder/agent.md`); the kickoff carries the issue and
 * its comments, the private debug report included, which stay inside the
 * session. The agent's PR says "Closes <identifier>", so Linear links it.
 *
 * Server to server, so there's no Origin to check: Linear's HMAC signature
 * over the raw body is the guard, with its timestamp bounding replays.
 */

export interface AgentTriggerConfig {
  webhookSecret: string;
  agentUserId: string;
  approverIds: readonly string[];
  triageStateId: string;
  /** The Managed Agents agent and environment, from `ant apply`. */
  agentId: string;
  environmentId: string;
  /** Holds the GitHub MCP credential the agent opens its PR with. */
  vaultId: string;
  repositoryUrl: string;
  /** Clones and pushes through Anthropic's git proxy; never enters the sandbox. */
  githubToken: string;
  /** The session's hard spend cap, in US cents. */
  budgetCents: number;
}

type SessionParams = Parameters<Anthropic["beta"]["sessions"]["create"]>[0];

export interface AgentTriggerDeps {
  config: AgentTriggerConfig;
  createSession: (params: SessionParams) => Promise<{ id: string }>;
  issueComments: IssueComments;
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

  let sessionId: string;
  try {
    sessionId = (await startSession(event, deps)).id;
  } catch (error) {
    // Linear retries a failed delivery, which retries the start.
    console.error("agent trigger: session not started", error);
    return json(502, { error: "Could not start the agent" });
  }
  // The agent is running either way; a missing comment only costs the link.
  await deps
    .createComment(
      event.data.id,
      `Agent started: https://platform.claude.com/workspaces/default/sessions/${sessionId}. Its pull request will say "Closes ${event.data.identifier}", which links it here.`,
    )
    .catch((error: unknown) => console.error("agent trigger: comment not added", error));
  return json(200, { outcome: "started", sessionId });
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

async function startSession(event: IssueEvent, deps: AgentTriggerDeps): Promise<{ id: string }> {
  const { config } = deps;
  const { id, identifier, title, url, description } = event.data;
  const comments = await deps.issueComments(id);
  const kickoff = [
    `Implement Linear issue ${identifier}: ${title}`,
    `URL: ${url}`,
    "",
    "## Description",
    "",
    description?.trim() || "(none)",
    "",
    "## Comments",
    "",
    ...(comments.length === 0
      ? ["(none)"]
      : comments.map(({ author, body }) => `### ${author}\n\n${body.trim()}\n`)),
  ].join("\n");

  return deps.createSession({
    agent: config.agentId,
    environment_id: config.environmentId,
    vault_ids: [config.vaultId],
    title: `${identifier}: ${title}`.slice(0, 200),
    metadata: { linear_issue: identifier },
    resources: [
      {
        type: "github_repository",
        url: config.repositoryUrl,
        authorization_token: config.githubToken,
        checkout: { type: "branch", name: "main" },
      },
    ],
    budget: { type: "limit", max_list_cost: { amount: String(config.budgetCents), currency: "USD" } },
    initial_events: [{ type: "user.message", content: [{ type: "text", text: kickoff }] }],
  });
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
