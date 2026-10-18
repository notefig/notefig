import assert from "node:assert/strict";
import { test } from "node:test";
import { handle, type Env } from "./index.ts";
import { validFeedback } from "./testing.ts";

const APP_ORIGIN = "tauri://localhost";

function setup({ limited = false } = {}) {
  const linearCalls: { headers: HeadersInit | undefined; body: unknown }[] = [];
  const env: Env = {
    RATE_LIMITER: { limit: async () => ({ success: !limited }) },
    LINEAR_API_KEY: "lin_api_test",
    LINEAR_TEAM_ID: "team",
    LINEAR_TRIAGE_STATE_ID: "triage",
    LINEAR_PROJECT_ID: "roadmap",
    LINEAR_FEEDBACK_LABEL_ID: "feedback",
    ALLOWED_ORIGINS: `${APP_ORIGIN},https://app.notefig.com`,
    AGENT_USER_ID: "agent-user",
    APPROVER_IDS: "approver-user",
    AGENT_REPOSITORY_URL: "https://github.com/notefig/notefig",
    AGENT_BUDGET_CENTS: "2000",
  };
  const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    linearCalls.push({ headers: init?.headers, body });
    return Response.json(
      body.query.includes("commentCreate")
        ? { data: { commentCreate: { success: true } } }
        : { data: { issueCreate: { success: true, issue: { id: "issue-1" } } } },
    );
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

test("refuses bodies over 8 MB and bodies that aren't JSON", async () => {
  const { env, fetchFn } = setup();
  assert.equal((await handle(post("x".repeat(8 * 1024 * 1024 + 1)), env, fetchFn)).status, 413);
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

test("puts the debug report in a comment on the new issue, not its description", async () => {
  const { env, fetchFn, linearCalls } = setup();
  const body = JSON.stringify({ ...validFeedback, debugReport: "=== Notefig Debug Report ===" });
  assert.equal((await handle(post(body), env, fetchFn)).status, 202);
  assert.equal(linearCalls.length, 2);
  const [issue, comment] = linearCalls.map((call) => call.body as { query: string; variables: { input: Record<string, string> } });
  assert.match(issue.query, /issueCreate/);
  assert.ok(!issue.variables.input.description.includes("Notefig Debug Report"));
  assert.match(comment.query, /commentCreate/);
  assert.equal(comment.variables.input.issueId, "issue-1");
  assert.match(comment.variables.input.body, /=== Notefig Debug Report ===/);
});

test("uploads a screenshot to Linear, files the issue, and links it in a private comment", async () => {
  const { env } = setup();
  const calls: { url: string; method?: string; headers?: Headers; body?: unknown }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method, headers: new Headers(init?.headers), body: init?.body });
    if (url === "https://upload.example/put") return new Response(null, { status: 200 });
    const { query } = JSON.parse(String(init?.body));
    if (query.includes("fileUpload")) {
      return Response.json({
        data: {
          fileUpload: {
            success: true,
            uploadFile: {
              uploadUrl: "https://upload.example/put",
              assetUrl: "https://uploads.linear.app/asset.png",
              headers: [{ key: "x-goog-meta-owner", value: "notefig" }],
            },
          },
        },
      });
    }
    if (query.includes("commentCreate")) {
      return Response.json({ data: { commentCreate: { success: true } } });
    }
    return Response.json({ data: { issueCreate: { success: true, issue: { id: "issue-1" } } } });
  }) as typeof fetch;

  const form = new FormData();
  form.append("feedback", JSON.stringify({ ...validFeedback, message: "Look\n\n![](attachment:img1)" }));
  form.append("img1", new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" }), "img1");
  const request = new Request("https://support.notefig.com/v1/feedback", {
    method: "POST",
    headers: { Origin: APP_ORIGIN },
    body: form,
  });

  const response = await handle(request, env, fetchFn);
  assert.equal(response.status, 202);
  assert.deepEqual(calls.map((call) => call.url), [
    "https://api.linear.app/graphql",
    "https://upload.example/put",
    "https://api.linear.app/graphql",
    "https://api.linear.app/graphql",
  ]);
  const put = calls[1];
  assert.equal(put.method, "PUT");
  assert.equal(put.headers?.get("Content-Type"), "image/png");
  assert.equal(put.headers?.get("x-goog-meta-owner"), "notefig");
  const issue = JSON.parse(String(calls[2].body)).variables.input;
  assert.match(issue.description, /^Look\n\n\*\[Screenshot 1\]\*\n/);
  assert.ok(!issue.description.includes("uploads.linear.app"));
  const comment = JSON.parse(String(calls[3].body)).variables.input;
  assert.equal(comment.issueId, "issue-1");
  assert.match(comment.body, /!\[Screenshot 1\]\(https:\/\/uploads\.linear\.app\/asset\.png\)/);
});

test("Linear's webhook skips the origin check, and waits for its secrets", async () => {
  const { env, fetchFn } = setup();
  const delivery = () =>
    new Request("https://support.notefig.com/v1/linear", { method: "POST", body: "{}" });
  // No Origin header, yet not refused as a stranger: unconfigured, it says so.
  assert.equal((await handle(delivery(), env, fetchFn)).status, 503);

  const configured: Env = {
    ...env,
    LINEAR_WEBHOOK_SECRET: "secret",
    ANTHROPIC_API_KEY: "sk-ant-test",
    MANAGED_AGENT_ID: "agent_1",
    MANAGED_ENVIRONMENT_ID: "env_1",
    AGENT_VAULT_ID: "vlt_1",
    AGENT_GITHUB_TOKEN: "github-token",
  };
  // Configured, an unsigned delivery is refused by the signature check.
  assert.equal((await handle(delivery(), configured, fetchFn)).status, 401);
});
