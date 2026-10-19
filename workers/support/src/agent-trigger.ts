import type Anthropic from "@anthropic-ai/sdk";
import { json } from "./http.ts";
import type { CreateComment, DownloadFile, IssueComments } from "./linear.ts";

/**
 * `POST /v1/linear`: Linear's webhook, which drives the feedback builder.
 *
 * - An approver assigns an accepted issue (out of Triage) to the agent
 *   account: a Claude Managed Agents session starts on it, with the issue,
 *   every comment (the private debug report included) and its screenshots.
 *   The Worker remembers the session for the issue and comments a link.
 * - An approver comments on that issue, or edits its title or description:
 *   the update goes to the same session as a new message. A session that
 *   finished goes idle, and the message wakes it to continue.
 *
 * Only approvers' actions count. Comments on the public GitHub issue sync
 * into Linear, so anyone else's would be a way to instruct the agent.
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

type Sessions = Anthropic["beta"]["sessions"];
type SessionParams = Parameters<Sessions["create"]>[0];
type MessageContent = Extract<
  NonNullable<SessionParams["initial_events"]>[number],
  { type: "user.message" }
>["content"];

export interface AgentTriggerDeps {
  config: AgentTriggerConfig;
  createSession: (params: SessionParams) => Promise<{ id: string }>;
  sendMessage: (sessionId: string, content: MessageContent) => Promise<unknown>;
  issueComments: IssueComments;
  createComment: CreateComment;
  downloadFile: DownloadFile;
  /** Delivery claims and each issue's session. */
  kv: Pick<KVNamespace, "get" | "put">;
  now: () => number;
}

const MAX_CLOCK_SKEW_MS = 60_000;
const DAY_SECONDS = 24 * 60 * 60;
const SESSION_TTL_SECONDS = 30 * DAY_SECONDS;
const MAX_IMAGES = 5;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
// What the Worker itself posts. Its Linear key may belong to an approver,
// so its comments are recognized by how they start, never forwarded.
const STARTED = "Agent started: ";
const NOT_STARTED = "The agent couldn't start.";
const WORKER_COMMENTS = [STARTED, NOT_STARTED];
const LINEAR_UPLOAD_IMAGE = /!\[[^\]]*\]\((https:\/\/uploads\.linear\.app\/[^)\s]+)\)/g;

interface IssueData {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  url: string;
  assigneeId?: string | null;
  stateId: string;
}

interface CommentData {
  id: string;
  body: string;
  issueId: string;
}

type LinearEvent = {
  action: string;
  webhookTimestamp: number;
  actor?: { id: string; name?: string };
  updatedFrom?: Record<string, unknown>;
} & ({ type: "Issue"; data: IssueData } | { type: "Comment"; data: CommentData } | { type: string; data: unknown });

export async function handleLinearWebhook(
  rawBody: string,
  signature: string | null,
  deliveryId: string | null,
  deps: AgentTriggerDeps,
): Promise<Response> {
  if (!(await signedBy(deps.config.webhookSecret, rawBody, signature))) {
    return json(401, { error: "Bad signature" });
  }
  let event: LinearEvent;
  try {
    event = JSON.parse(rawBody) as LinearEvent;
  } catch {
    return json(400, { error: "Body is not JSON" });
  }
  if (Math.abs(deps.now() - event.webhookTimestamp) > MAX_CLOCK_SKEW_MS) {
    return json(401, { error: "Stale webhook" });
  }
  if (!deps.config.approverIds.includes(event.actor?.id ?? "")) return json(200, { outcome: "ignored" });

  if (isIssue(event) && assignsAgent(event, deps.config)) return start(event.data, deliveryId, deps);
  if (isIssue(event) && editsText(event)) {
    return forward(event.data.id, [issueEditText(event.data)], [event.data.description], deps);
  }
  if (isComment(event) && event.action === "create" && !WORKER_COMMENTS.some((p) => event.data.body.startsWith(p))) {
    const author = event.actor?.name ?? "An approver";
    return forward(event.data.issueId, [`New comment from ${author}:\n\n${event.data.body}`], [event.data.body], deps);
  }
  return json(200, { outcome: "ignored" });
}

function isIssue(event: LinearEvent): event is LinearEvent & { type: "Issue"; data: IssueData } {
  return event.type === "Issue";
}

function isComment(event: LinearEvent): event is LinearEvent & { type: "Comment"; data: CommentData } {
  return event.type === "Comment";
}

/** Given to the agent account just now (or created that way), out of Triage. */
function assignsAgent(event: LinearEvent & { data: IssueData }, config: AgentTriggerConfig): boolean {
  const assignedNow =
    event.action === "create" ||
    (event.action === "update" && event.updatedFrom !== undefined && "assigneeId" in event.updatedFrom);
  return assignedNow && event.data.assigneeId === config.agentUserId && event.data.stateId !== config.triageStateId;
}

function editsText(event: LinearEvent): boolean {
  const changed = event.updatedFrom ?? {};
  return event.action === "update" && ("title" in changed || "description" in changed);
}

function issueEditText({ identifier, title, description }: IssueData): string {
  return [`${identifier} was edited. It now reads:`, "", `Title: ${title}`, "", "Description:", "", description?.trim() || "(none)"].join(
    "\n",
  );
}

/**
 * Starts the session for an assignment. Each Linear delivery is claimed
 * first, so a retried delivery can't start a second paid run. A start that
 * fails says so on the issue instead of leaving Linear to retry: assigning
 * the agent again is a new delivery, and a new try.
 */
async function start(issue: IssueData, deliveryId: string | null, deps: AgentTriggerDeps): Promise<Response> {
  if (deliveryId) {
    if (await deps.kv.get(`delivery:${deliveryId}`)) return json(200, { outcome: "duplicate" });
    await deps.kv.put(`delivery:${deliveryId}`, "1", { expirationTtl: DAY_SECONDS });
  }
  let sessionId: string;
  try {
    sessionId = (await deps.createSession(await sessionParams(issue, deps))).id;
  } catch (error) {
    console.error("agent trigger: session not started", error);
    await comment(deps, issue.id, `${NOT_STARTED} Assign it to Notefig Support again to retry.`);
    return json(200, { outcome: "failed" });
  }
  await deps.kv.put(`issue:${issue.id}`, sessionId, { expirationTtl: SESSION_TTL_SECONDS });
  await comment(
    deps,
    issue.id,
    `${STARTED}https://platform.claude.com/workspaces/default/sessions/${sessionId}. Its pull request will say "Closes ${issue.identifier}", which links it here. Your comments and edits on this issue go to it.`,
  );
  return json(200, { outcome: "started", sessionId });
}

async function sessionParams(issue: IssueData, deps: AgentTriggerDeps): Promise<SessionParams> {
  const { config } = deps;
  const comments = await deps.issueComments(issue.id);
  const text = [
    `Implement Linear issue ${issue.identifier}: ${issue.title}`,
    `URL: ${issue.url}`,
    "",
    "## Description",
    "",
    issue.description?.trim() || "(none)",
    "",
    "## Comments",
    "",
    ...(comments.length === 0 ? ["(none)"] : comments.map(({ author, body }) => `### ${author}\n\n${body.trim()}\n`)),
  ].join("\n");
  const markdown = [issue.description ?? "", ...comments.map(({ body }) => body)];
  return {
    agent: config.agentId,
    environment_id: config.environmentId,
    vault_ids: [config.vaultId],
    title: `${issue.identifier}: ${issue.title}`.slice(0, 200),
    metadata: { linear_issue: issue.identifier },
    resources: [
      {
        type: "github_repository",
        url: config.repositoryUrl,
        authorization_token: config.githubToken,
        checkout: { type: "branch", name: "main" },
      },
    ],
    budget: { type: "limit", max_list_cost: { amount: String(config.budgetCents), currency: "USD" } },
    initial_events: [{ type: "user.message", content: await withScreenshots(text, markdown, deps) }],
  };
}

/** Sends an approver's update to the issue's session, if it has one. */
async function forward(
  issueId: string,
  text: string[],
  markdown: (string | null | undefined)[],
  deps: AgentTriggerDeps,
): Promise<Response> {
  const sessionId = await deps.kv.get(`issue:${issueId}`);
  if (!sessionId) return json(200, { outcome: "ignored" });
  try {
    await deps.sendMessage(sessionId, await withScreenshots(text.join("\n\n"), markdown, deps));
  } catch (error) {
    // A session that was archived, or paused at its budget, takes no messages.
    console.error("agent trigger: update not forwarded", error);
    return json(200, { outcome: "not-forwarded" });
  }
  return json(200, { outcome: "forwarded", sessionId });
}

/**
 * The message's text, then the screenshots its markdown shows, as images:
 * the sandbox can't reach Linear's file host, so the Worker fetches them
 * with its key. At most `MAX_IMAGES`; one that won't download is skipped.
 */
async function withScreenshots(
  text: string,
  markdown: (string | null | undefined)[],
  deps: AgentTriggerDeps,
): Promise<MessageContent> {
  const urls = [...new Set(markdown.flatMap((body) => [...(body ?? "").matchAll(LINEAR_UPLOAD_IMAGE)].map((m) => m[1])))];
  const images: MessageContent = [];
  for (const url of urls.slice(0, MAX_IMAGES)) {
    const file = await deps.downloadFile(url).catch(() => null);
    if (!file || !IMAGE_TYPES.has(file.mediaType)) continue;
    images.push({
      type: "image",
      source: { type: "base64", media_type: file.mediaType as "image/png", data: toBase64(file.bytes) },
    });
  }
  const note = images.length > 0 ? `\n\n(${images.length} screenshot(s) from the issue follow, in order.)` : "";
  return [{ type: "text", text: text + note }, ...images];
}

async function comment(deps: AgentTriggerDeps, issueId: string, body: string): Promise<void> {
  await deps.createComment(issueId, body).catch((error: unknown) => {
    console.error("agent trigger: comment not added", error);
  });
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  // Chunked: String.fromCharCode over a whole image overflows the stack.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
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
