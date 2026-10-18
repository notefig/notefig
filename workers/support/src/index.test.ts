import assert from "node:assert/strict";
import { test } from "node:test";
import { handle, type Env } from "./index.ts";
import { fakeKv, validFeedback } from "./testing.ts";

const APP_ORIGIN = "tauri://localhost";

function setup({ limited = false } = {}) {
  const linearCalls: { headers: HeadersInit | undefined; body: unknown }[] = [];
  const env: Env = {
    SUPPORT_KV: fakeKv(),
    RATE_LIMITER: { limit: async () => ({ success: !limited }) },
    LINEAR_API_KEY: "lin_api_test",
    LINEAR_TEAM_ID: "team",
    LINEAR_TRIAGE_STATE_ID: "triage",
    LINEAR_PROJECT_ID: "roadmap",
    LINEAR_FEEDBACK_LABEL_ID: "feedback",
    LINEAR_BUG_LABEL_ID: "bug",
    LINEAR_IDEA_LABEL_ID: "idea",
    ALLOWED_ORIGINS: `${APP_ORIGIN},https://app.notefig.com`,
  };
  const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    linearCalls.push({ headers: init?.headers, body: JSON.parse(String(init?.body)) });
    return Response.json({ data: { issueCreate: { success: true } } });
  }) as typeof fetch;
  return { env, fetchFn, linearCalls };
}

function post(body: string, origin = APP_ORIGIN, path = "/v1/feedback") {
  return new Request(`https://support.notefig.com${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body,
  });
}

test("files posted feedback with Linear, as the API key", async () => {
  const { env, fetchFn, linearCalls } = setup();
  const response = await handle(post(JSON.stringify(validFeedback)), env, fetchFn);
  assert.equal(response.status, 202);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), APP_ORIGIN);
  assert.equal(linearCalls.length, 1);
  assert.deepEqual(linearCalls[0].headers, {
    "Content-Type": "application/json",
    Authorization: "lin_api_test",
  });
});

test("answers the app's preflight", async () => {
  const { env, fetchFn } = setup();
  const preflight = new Request("https://support.notefig.com/v1/feedback", {
    method: "OPTIONS",
    headers: { Origin: APP_ORIGIN },
  });
  const allowed = await handle(preflight, env, fetchFn);
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get("Access-Control-Allow-Methods"), "POST");
});

test("refuses other origins and origin-less requests without filing anything", async () => {
  const { env, fetchFn, linearCalls } = setup();
  // A "simple" text/plain POST: a browser sends it from any page without a preflight.
  const simplePost = new Request("https://support.notefig.com/v1/feedback", {
    method: "POST",
    headers: { "Content-Type": "text/plain", Origin: "https://evil.example" },
    body: JSON.stringify(validFeedback),
  });
  const elsewhere = await handle(simplePost, env, fetchFn);
  assert.equal(elsewhere.status, 403);
  assert.equal(elsewhere.headers.get("Access-Control-Allow-Origin"), null);

  const noOrigin = new Request("https://support.notefig.com/v1/feedback", {
    method: "POST",
    body: JSON.stringify(validFeedback),
  });
  assert.equal((await handle(noOrigin, env, fetchFn)).status, 403);
  assert.equal(linearCalls.length, 0);
});

test("rate-limited callers get 429 before the body is read", async () => {
  const { env, fetchFn, linearCalls } = setup({ limited: true });
  const response = await handle(post(JSON.stringify(validFeedback)), env, fetchFn);
  assert.equal(response.status, 429);
  assert.equal(linearCalls.length, 0);
});

test("refuses bodies over 16 KB and bodies that aren't JSON", async () => {
  const { env, fetchFn } = setup();
  assert.equal((await handle(post("x".repeat(16 * 1024 + 1)), env, fetchFn)).status, 413);
  assert.equal((await handle(post("{not json"), env, fetchFn)).status, 400);
});

test("routes only POST /v1/feedback", async () => {
  const { env, fetchFn } = setup();
  assert.equal((await handle(post("{}", APP_ORIGIN, "/v1/roadmap"), env, fetchFn)).status, 404);
  const get = new Request("https://support.notefig.com/v1/feedback", { headers: { Origin: APP_ORIGIN } });
  assert.equal((await handle(get, env, fetchFn)).status, 405);
});

test("answers 502 when Linear rejects the issue", async () => {
  const { env } = setup();
  const failing = (async () =>
    Response.json({ errors: [{ message: "Entity not found: Team" }] }, { status: 400 })) as typeof fetch;
  const quiet = console.error;
  console.error = () => {};
  try {
    assert.equal((await handle(post(JSON.stringify(validFeedback)), env, failing)).status, 502);
  } finally {
    console.error = quiet;
  }
});
