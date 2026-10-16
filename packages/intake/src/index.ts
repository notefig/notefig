import { corsHeaders, readBody, toResponse } from "./http";
import { createLinearClient, type LinearClient } from "./linear";
import { handleLinearWebhook } from "./linear-webhook";
import type { WorkflowState } from "./state-object";
import type { WorkflowStore } from "./store";
import { handleSubmission, type HttpResult } from "./submit";
import { findWorkflow, workflows } from "./workflows";

export { WorkflowState } from "./state-object";

/**
 * The intake service: takes public submissions for each workflow
 * (`POST /v1/workflows/<id>/submissions`) into Linear Triage, and Linear's
 * Issue webhook (`POST /v1/linear/webhook`) to act on accepted issues. See
 * README.md for setup.
 */
export interface Env {
  WORKFLOW_STATE: DurableObjectNamespace<WorkflowState>;
  SUBMIT_LIMITER: RateLimit;
  LINEAR_API_KEY: string;
  LINEAR_WEBHOOK_SECRET: string;
  SUBMITTER_SALT: string;
  LINEAR_TEAM_KEY: string;
  /** Comma-separated Linear user ids whose Triage moves count. */
  LINEAR_APPROVER_IDS: string;
  /** Comma-separated origins the app is served from. */
  ALLOWED_ORIGINS: string;
}

const MAX_BODY_BYTES = 16_384;
const SUBMISSION_ROUTE = /^\/v1\/workflows\/([a-z0-9-]+)\/submissions$/;
const WEBHOOK_ROUTE = "/v1/linear/webhook";

let linearCache: { key: string; client: LinearClient } | undefined;

/** One client per isolate, so the Linear context cache outlives a request. */
function linearFor(env: Env): LinearClient {
  const key = `${env.LINEAR_TEAM_KEY}:${env.LINEAR_API_KEY}`;
  if (linearCache?.key !== key) {
    linearCache = {
      key,
      client: createLinearClient({ apiKey: env.LINEAR_API_KEY, teamKey: env.LINEAR_TEAM_KEY }),
    };
  }
  return linearCache.client;
}

function storeFor(env: Env) {
  return (workflowId: string): WorkflowStore =>
    env.WORKFLOW_STATE.get(env.WORKFLOW_STATE.idFromName(workflowId));
}

async function submit(request: Request, env: Env, workflowId: string): Promise<HttpResult> {
  const workflow = findWorkflow(workflowId);
  if (!workflow) return { status: 404, body: { error: "Unknown workflow" } };
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const { success } = await env.SUBMIT_LIMITER.limit({ key: `${workflowId}:${ip}` });
  if (!success) return { status: 429, body: { error: "Slow down and try again in a minute." } };
  const text = await readBody(request, MAX_BODY_BYTES);
  if (text === undefined) return { status: 413, body: { error: "Submission too large" } };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { status: 400, body: { error: "Bad JSON" } };
  }
  return handleSubmission(
    {
      linear: linearFor(env),
      store: storeFor(env),
      salt: env.SUBMITTER_SALT,
      newId: () => `sub_${crypto.randomUUID()}`,
      warn: (message, error) => console.warn(message, error),
    },
    workflow,
    body,
    `ip:${ip}`,
  );
}

async function webhook(request: Request, env: Env): Promise<HttpResult> {
  return handleLinearWebhook(
    {
      secret: env.LINEAR_WEBHOOK_SECRET,
      linear: linearFor(env),
      store: storeFor(env),
      workflows,
      approverIds: env.LINEAR_APPROVER_IDS.split(",").map((id) => id.trim()),
      now: Date.now,
    },
    await request.text(),
    request.headers.get("linear-signature"),
  );
}

async function route(request: Request, env: Env): Promise<HttpResult> {
  const { pathname } = new URL(request.url);
  if (request.method === "GET" && pathname === "/health") return { status: 200, body: { ok: true } };
  if (request.method !== "POST") return { status: 404, body: { error: "Not found" } };
  if (pathname === WEBHOOK_ROUTE) return webhook(request, env);
  const submission = SUBMISSION_ROUTE.exec(pathname);
  if (submission) return submit(request, env, submission[1]);
  return { status: 404, body: { error: "Not found" } };
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env.ALLOWED_ORIGINS);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: cors ? 204 : 403, headers: cors });
    }
    try {
      return toResponse(await route(request, env), cors);
    } catch (error) {
      console.error(error);
      return toResponse({ status: 500, body: { error: "Something went wrong" } }, cors);
    }
  },
} satisfies ExportedHandler<Env>;
