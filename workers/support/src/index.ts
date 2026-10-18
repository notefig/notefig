import { submitFeedback } from "./feedback.ts";
import { corsHeaders, json, readJson } from "./http.ts";
import { linearClient } from "./linear.ts";

/**
 * support.notefig.com: the endpoints the app talks to for feedback and,
 * later, the roadmap. Each route is `/v1/<name>`, handled by its own file.
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
}

// A 50,000-character debug report, worst case in UTF-8, plus the message.
const MAX_BODY_BYTES = 256 * 1024;

export async function handle(request: Request, env: Env, fetchFn: typeof fetch): Promise<Response> {
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
      const body = await readJson(request, MAX_BODY_BYTES);
      if ("error" in body) return body.error;
      return submitFeedback(body.value, {
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

export default {
  // Wrapped: the Workers runtime rejects a detached `fetch` ("Illegal invocation").
  fetch: (request, env) => handle(request, env, (input, init) => fetch(input, init)),
} satisfies ExportedHandler<Env>;
