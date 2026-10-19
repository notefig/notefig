import assert from "node:assert/strict";
import { test } from "node:test";
import { handleLinearWebhook, type AgentTriggerDeps } from "./agent-trigger.ts";

const SECRET = "whsec-test";
const AGENT = "agent-user";
const APPROVER = "approver-user";
const NOW = Date.parse("2026-10-19T12:00:00Z");

function issueEvent(overrides: Record<string, unknown> = {}, data: Record<string, unknown> = {}) {
  return {
    action: "update",
    type: "Issue",
    webhookTimestamp: NOW,
    actor: { id: APPROVER },
    data: {
      id: "issue-uuid",
      identifier: "MET-42",
      title: "Sidebar flickers on rename",
      description: "The tree jumps when I rename a file.",
      url: "https://linear.app/notefig/issue/MET-42",
      assigneeId: AGENT,
      stateId: "todo",
      ...data,
    },
    updatedFrom: { assigneeId: null },
    ...overrides,
  };
}

async function sign(body: string, secret = SECRET): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(mac), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function setup(fireStatus = 200) {
  const fires: { url: string; headers: Headers; body: { text: string } }[] = [];
  const comments: { issueId: string; body: string }[] = [];
  const deps: AgentTriggerDeps = {
    config: {
      webhookSecret: SECRET,
      agentUserId: AGENT,
      approverIds: [APPROVER],
      triageStateId: "triage",
      routineFireUrl: "https://api.anthropic.com/v1/claude_code/routines/trig_1/fire",
      routineToken: "routine-token",
    },
    fetchFn: (async (input: RequestInfo | URL, init?: RequestInit) => {
      fires.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return fireStatus === 200
        ? Response.json({ claude_code_session_id: "s1", claude_code_session_url: "https://claude.ai/code/s1" })
        : new Response("down", { status: fireStatus });
    }) as typeof fetch,
    createComment: async (issueId, body) => void comments.push({ issueId, body }),
    kv: fakeKv(),
    now: () => NOW,
  };
  return { deps, fires, comments };
}

function fakeKv() {
  const values = new Map<string, string>();
  return {
    async get(key: string) {
      return values.get(key) ?? null;
    },
    async put(key: string, value: string) {
      values.set(key, value);
    },
  } as unknown as KVNamespace;
}

async function deliver(
  event: unknown,
  deps: AgentTriggerDeps,
  signature?: string | null,
  delivery: string | null = "delivery-1",
) {
  const body = JSON.stringify(event);
  return handleLinearWebhook(body, signature === undefined ? await sign(body) : signature, delivery, deps);
}

async function quietly<T>(run: () => Promise<T>): Promise<T> {
  const error = console.error;
  console.error = () => {};
  try {
    return await run();
  } finally {
    console.error = error;
  }
}

test("starts the routine when an approver assigns an accepted issue to the agent", async () => {
  const { deps, fires, comments } = setup();
  const response = await deliver(issueEvent(), deps);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { outcome: "started" });

  assert.equal(fires.length, 1);
  const [fire] = fires;
  assert.equal(fire.url, "https://api.anthropic.com/v1/claude_code/routines/trig_1/fire");
  assert.equal(fire.headers.get("Authorization"), "Bearer routine-token");
  assert.equal(fire.headers.get("anthropic-beta"), "experimental-cc-routine-2026-04-01");
  assert.equal(fire.headers.get("anthropic-version"), "2023-06-01");
  assert.equal(
    fire.body.text,
    [
      "Linear issue MET-42 (id issue-uuid)",
      "Title: Sidebar flickers on rename",
      "URL: https://linear.app/notefig/issue/MET-42",
      "",
      "Description:",
      "The tree jumps when I rename a file.",
    ].join("\n"),
  );
  assert.deepEqual(comments, [
    {
      issueId: "issue-uuid",
      body: "Agent started: https://claude.ai/code/s1 It will link its pull request here.",
    },
  ]);
});

test("starts it for an issue created already assigned to the agent", async () => {
  const { deps, fires } = setup();
  await deliver(issueEvent({ action: "create", updatedFrom: undefined }), deps);
  assert.equal(fires.length, 1);
});

test("ignores events that don't hand an accepted issue to the agent", async () => {
  const { deps, fires } = setup();
  const ignored = [
    issueEvent({ actor: { id: "someone-else" } }),
    issueEvent({}, { assigneeId: "another-user" }),
    issueEvent({}, { stateId: "triage" }),
    issueEvent({ updatedFrom: { title: "old title" } }),
    issueEvent({ type: "Comment" }),
    issueEvent({ action: "remove" }),
  ];
  for (const event of ignored) {
    const response = await deliver(event, deps);
    assert.deepEqual(await response.json(), { outcome: "ignored" }, JSON.stringify(event));
  }
  assert.equal(fires.length, 0);
});

test("refuses unsigned, wrongly signed and stale deliveries", async () => {
  const { deps, fires } = setup();
  const event = issueEvent();
  assert.equal((await deliver(event, deps, null)).status, 401);
  assert.equal((await deliver(event, deps, "zz")).status, 401);
  const body = JSON.stringify(event);
  assert.equal((await handleLinearWebhook(body, await sign(body, "other-secret"), "d", deps)).status, 401);
  assert.equal((await deliver(issueEvent({ webhookTimestamp: NOW - 61_000 }), deps)).status, 401);
  assert.equal(fires.length, 0);
});

test("says so on the issue when the routine won't start, instead of letting Linear retry", async () => {
  const { deps, comments } = setup(500);
  const response = await quietly(() => deliver(issueEvent(), deps));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { outcome: "failed" });
  assert.deepEqual(comments.map(({ body }) => body), [
    "The agent couldn't start. Assign it to Notefig Support again to retry.",
  ]);
});

test("fires one run per Linear delivery, however often it's retried", async () => {
  const { deps, fires } = setup();
  await deliver(issueEvent(), deps, undefined, "delivery-7");
  const retry = await deliver(issueEvent(), deps, undefined, "delivery-7");
  assert.deepEqual(await retry.json(), { outcome: "duplicate" });
  assert.equal(fires.length, 1);
  // Assigning again is a new delivery, and a new run.
  await deliver(issueEvent(), deps, undefined, "delivery-8");
  assert.equal(fires.length, 2);
});

test("still reports started when only the comment fails", async () => {
  const { deps } = setup();
  deps.createComment = async () => {
    throw new Error("comment refused");
  };
  const response = await quietly(() => deliver(issueEvent(), deps));
  assert.deepEqual(await response.json(), { outcome: "started" });
});
