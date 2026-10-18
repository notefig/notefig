import { handleLinearWebhook } from "./agent-trigger.ts";
import { submitFeedback } from "./feedback.ts";
import { corsHeaders, json, readBody } from "./http.ts";
import { linearClient } from "./linear.ts";

/**
 * support.notefig.com: the endpoints the app talks to for feedback and,
 * later, the roadmap, plus Linear's webhook that hands accepted issues to
 * the agent. Each route is `/v1/<name>`, handled by its own file.
 */

export interface Env {
  RATE_LIMITER: RateLimit;
  LINEAR_API_KEY: string;
  LINEAR_TEAM_ID: string;
  LINEAR_TRIAGE_STATE_ID: string;
  LINEAR_PROJECT_ID: string;
  LINEAR_FEEDBACK_LABEL_ID: string;
  /** Comma-separated origins allowed to call from a browser. */
  ALLOWED_ORIGINS: string;
  /** The Linear user the agent works as, and who may assign it work. */
  AGENT_USER_ID: string;
  /** Comma-separated Linear user ids. */
  APPROVER_IDS: string;
  // Secrets set once with `wrangler secret put`; the agent route answers
  // 503 until they are.
  LINEAR_WEBHOOK_SECRET?: string;
  CLAUDE_ROUTINE_FIRE_URL?: string;
  CLAUDE_ROUTINE_TOKEN?: string;
}

// Up to three 2 MB screenshots, a 50,000-character debug report, and the message.
const MAX_BODY_BYTES = 8 * 1024 * 1024;

// Linear's webhook body: an issue event, never large.
const MAX_WEBHOOK_BYTES = 256 * 1024;

export async function handle(request: Request, env: Env, fetchFn: typeof fetch): Promise<Response> {
  // Server to server: no Origin, guarded by Linear's signature instead.
  if (new URL(request.url).pathname === "/v1/linear") return linearWebhook(request, env, fetchFn);
  const allowedOrigins = env.ALLOWED_ORIGINS.split(",");
  // CORS alone only hides the response: a page elsewhere can still send a
  // "simple" text/plain POST with no preflight. So anything not from the
  // app's own origins is refused before it reaches a route.
  if (!allowedOrigins.includes(request.headers.get("Origin") ?? "")) {
    return json(403, { error: "Origin not allowed" });
  }
  const cors = corsHeaders(request, allowedOrigins);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const response = await route(request, env, fetchFn);
  for (const [name, value] of Object.entries(cors)) response.headers.set(name, value);
  return response;
}

async function route(request: Request, env: Env, fetchFn: typeof fetch): Promise<Response> {
  const { pathname } = new URL(request.url);
  switch (pathname) {
    case "/v1/feedback": {
      if (request.method !== "POST") return json(405, { error: "Use POST" });
      const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
      const { success } = await env.RATE_LIMITER.limit({ key: `feedback:${ip}` });
      if (!success) return json(429, { error: "Too many requests" });
      const read = await readBody(request, MAX_BODY_BYTES);
      if ("error" in read) return read.error;
      return submitFeedback(read.body, request.headers.get("Content-Type"), {
        ...linearClient(env.LINEAR_API_KEY, fetchFn),
        config: {
          teamId: env.LINEAR_TEAM_ID,
          triageStateId: env.LINEAR_TRIAGE_STATE_ID,
          projectId: env.LINEAR_PROJECT_ID,
          feedbackLabelId: env.LINEAR_FEEDBACK_LABEL_ID,
        },
      });
    }
    default:
      return json(404, { error: "Not found" });
  }
}

async function linearWebhook(request: Request, env: Env, fetchFn: typeof fetch): Promise<Response> {
  if (request.method !== "POST") return json(405, { error: "Use POST" });
  const { LINEAR_WEBHOOK_SECRET, CLAUDE_ROUTINE_FIRE_URL, CLAUDE_ROUTINE_TOKEN } = env;
  if (!LINEAR_WEBHOOK_SECRET || !CLAUDE_ROUTINE_FIRE_URL || !CLAUDE_ROUTINE_TOKEN) {
    return json(503, { error: "Agent trigger not configured" });
  }
  const read = await readBody(request, MAX_WEBHOOK_BYTES);
  if ("error" in read) return read.error;
  return handleLinearWebhook(await read.body.text(), request.headers.get("Linear-Signature"), {
    config: {
      webhookSecret: LINEAR_WEBHOOK_SECRET,
      agentUserId: env.AGENT_USER_ID,
      approverIds: env.APPROVER_IDS.split(","),
      triageStateId: env.LINEAR_TRIAGE_STATE_ID,
      routineFireUrl: CLAUDE_ROUTINE_FIRE_URL,
      routineToken: CLAUDE_ROUTINE_TOKEN,
    },
    fetchFn,
    createComment: linearClient(env.LINEAR_API_KEY, fetchFn).createComment,
    now: Date.now,
  });
}

export default {
  // Wrapped: the Workers runtime rejects a detached `fetch` ("Illegal invocation").
  fetch: (request, env) => handle(request, env, (input, init) => fetch(input, init)),
} satisfies ExportedHandler<Env>;
