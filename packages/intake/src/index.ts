import { GITHUB_OIDC_KEYS_URL, handleBuildResult } from "./build-results";
import { linearFor, type Env } from "./env";
import { corsHeaders, readBody, toResponse } from "./http";
import { remoteKeySet, type KeySet } from "./jwt";
import { handleLinearWebhook } from "./linear-webhook";
import { readReport, REPORT_ROUTE, reportPath } from "./reports";
import type { WorkflowStore } from "./store";
import { handleSubmission, type HttpResult } from "./submit";
import { findWorkflow, workflows } from "./workflows";

export { BuildQueueObject } from "./build-queue-object";
export { WorkflowState } from "./state-object";
export type { Env } from "./env";

/**
 * The intake service (README.md):
 * - `POST /v1/workflows/<id>/submissions`: public submissions, into Linear Triage.
 * - `POST /v1/linear/webhook`: Linear's Issue webhook — accepting, declining,
 *   and starting agent builds.
 * - `POST /v1/builds/result`: agent-build.yml reporting how a build ended.
 * - `GET /v1/reports/<workflow>/<id>`: a private report, behind Cloudflare Access.
 */

/** Submissions carry the debug report (DEBUG_REPORT_MAX characters) as JSON. */
const MAX_SUBMISSION_BYTES = 640_000;
const MAX_RESULT_BYTES = 32_768;
/** Linear's Issue payloads are a few kilobytes; descriptions are the bulk. */
const MAX_WEBHOOK_BYTES = 262_144;
const SUBMISSION_ROUTE = /^\/v1\/workflows\/([a-z0-9-]+)\/submissions$/;

const keySets: { access?: { url: string; keys: KeySet }; github?: KeySet } = {};

function accessKeys(teamDomain: string): KeySet {
  const url = `https://${teamDomain}/cdn-cgi/access/certs`;
  if (keySets.access?.url !== url) keySets.access = { url, keys: remoteKeySet(url) };
  return keySets.access.keys;
}

function githubKeys(): KeySet {
  keySets.github ??= remoteKeySet(GITHUB_OIDC_KEYS_URL);
  return keySets.github;
}

function storeFor(env: Env) {
  return (workflowId: string): WorkflowStore =>
    env.WORKFLOW_STATE.get(env.WORKFLOW_STATE.idFromName(workflowId));
}

function buildQueue(env: Env) {
  return env.BUILD_QUEUE.get(env.BUILD_QUEUE.idFromName("builds"));
}

type Parsed = { ok: true; json: unknown } | { ok: false; result: HttpResult };

async function parseJson(request: Request, maxBytes: number): Promise<Parsed> {
  const text = await readBody(request, maxBytes);
  if (text === undefined) return { ok: false, result: { status: 413, body: { error: "Too large" } } };
  try {
    return { ok: true, json: JSON.parse(text) };
  } catch {
    return { ok: false, result: { status: 400, body: { error: "Bad JSON" } } };
  }
}

async function submit(request: Request, env: Env, workflowId: string): Promise<HttpResult> {
  const workflow = findWorkflow(workflowId);
  if (!workflow) return { status: 404, body: { error: "Unknown workflow" } };
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const { success } = await env.SUBMIT_LIMITER.limit({ key: `${workflowId}:${ip}` });
  if (!success) return { status: 429, body: { error: "Slow down and try again in a minute." } };
  const parsed = await parseJson(request, MAX_SUBMISSION_BYTES);
  if (!parsed.ok) return parsed.result;
  const origin = new URL(request.url).origin;
  return handleSubmission(
    {
      linear: linearFor(env),
      store: storeFor(env),
      salt: env.SUBMITTER_SALT,
      newId: () => `sub_${crypto.randomUUID()}`,
      reportUrl: (id, reportId) => `${origin}${reportPath(id, reportId)}`,
      warn: (message, error) => console.warn(message, error),
    },
    workflow,
    parsed.json,
    `ip:${ip}`,
  );
}

async function webhook(request: Request, env: Env): Promise<HttpResult> {
  const signature = request.headers.get("linear-signature");
  if (!signature) return { status: 401, body: { error: "Bad signature" } };
  const body = await readBody(request, MAX_WEBHOOK_BYTES);
  if (body === undefined) return { status: 413, body: { error: "Too large" } };
  return handleLinearWebhook(
    {
      secret: env.LINEAR_WEBHOOK_SECRET,
      linear: linearFor(env),
      store: storeFor(env),
      builds: buildQueue(env),
      workflows,
      approverIds: env.LINEAR_APPROVER_IDS.split(",").map((id) => id.trim()),
      now: Date.now,
    },
    body,
    signature,
  );
}

async function buildResult(request: Request, env: Env): Promise<HttpResult> {
  const parsed = await parseJson(request, MAX_RESULT_BYTES);
  if (!parsed.ok) return parsed.result;
  const queue = buildQueue(env);
  return handleBuildResult(
    {
      keys: githubKeys(),
      audience: new URL(request.url).origin,
      repository: env.GITHUB_REPOSITORY,
      report: (result) => queue.report(result),
      now: Date.now,
    },
    request.headers.get("authorization"),
    parsed.json,
  );
}

function report(request: Request, env: Env, workflowId: string, reportId: string) {
  const { ACCESS_TEAM_DOMAIN: teamDomain, ACCESS_AUD: audience } = env;
  return readReport(
    {
      access:
        teamDomain && audience
          ? { teamDomain, audience, keys: accessKeys(teamDomain) }
          : undefined,
      store: (id) => (findWorkflow(id) ? storeFor(env)(id) : undefined),
      now: Date.now,
    },
    request.headers.get("cf-access-jwt-assertion"),
    workflowId,
    reportId,
  );
}

const NOT_FOUND: HttpResult = { status: 404, body: { error: "Not found" } };

const ROUTES: Record<string, (request: Request, env: Env) => Promise<HttpResult>> = {
  "GET /health": async () => ({ status: 200, body: { ok: true } }),
  "POST /v1/linear/webhook": webhook,
  "POST /v1/builds/result": buildResult,
};

async function route(request: Request, env: Env): Promise<HttpResult> {
  const { pathname } = new URL(request.url);
  const handler = ROUTES[`${request.method} ${pathname}`];
  if (handler) return handler(request, env);
  const submission = request.method === "POST" && SUBMISSION_ROUTE.exec(pathname);
  return submission ? submit(request, env, submission[1]) : NOT_FOUND;
}

export default {
  async fetch(request, env) {
    const reportMatch = request.method === "GET" && REPORT_ROUTE.exec(new URL(request.url).pathname);
    if (reportMatch) return report(request, env, reportMatch[1], reportMatch[2]);
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
