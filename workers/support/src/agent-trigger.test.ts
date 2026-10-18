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

function setup(sessionFails = false) {
  const sessions: Parameters<AgentTriggerDeps["createSession"]>[0][] = [];
  const comments: { issueId: string; body: string }[] = [];
  const deps: AgentTriggerDeps = {
    config: {
      webhookSecret: SECRET,
      agentUserId: AGENT,
      approverIds: [APPROVER],
      triageStateId: "triage",
      agentId: "agent_1",
      environmentId: "env_1",
      vaultId: "vlt_1",
      repositoryUrl: "https://github.com/notefig/notefig",
      githubToken: "github-token",
      budgetCents: 2000,
    },
    createSession: async (params) => {
      if (sessionFails) throw new Error("Managed Agents down");
      sessions.push(params);
      return { id: "sesn_1" };
    },
    issueComments: async () => [
      { author: "Notefig Support", body: "### Debug report\n\n```text\n=== Notefig Debug Report ===\n```" },
      { author: "Parsa", body: "Looks like the tree re-renders." },
    ],
    createComment: async (issueId, body) => void comments.push({ issueId, body }),
    now: () => NOW,
  };
  return { deps, sessions, comments };
}

async function deliver(event: unknown, deps: AgentTriggerDeps, signature?: string | null) {
  const body = JSON.stringify(event);
  return handleLinearWebhook(body, signature === undefined ? await sign(body) : signature, deps);
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

test("starts a session when an approver assigns an accepted issue to the agent", async () => {
  const { deps, sessions, comments } = setup();
  const response = await deliver(issueEvent(), deps);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { outcome: "started", sessionId: "sesn_1" });

  assert.equal(sessions.length, 1);
  const { initial_events, ...session } = sessions[0];
  assert.deepEqual(session, {
    agent: "agent_1",
    environment_id: "env_1",
    vault_ids: ["vlt_1"],
    title: "MET-42: Sidebar flickers on rename",
    metadata: { linear_issue: "MET-42" },
    resources: [
      {
        type: "github_repository",
        url: "https://github.com/notefig/notefig",
        authorization_token: "github-token",
        checkout: { type: "branch", name: "main" },
      },
    ],
    budget: { type: "limit", max_list_cost: { amount: "2000", currency: "USD" } },
  });
  // The kickoff carries the issue and every comment, the private one too.
  const kickoff = (initial_events?.[0] as { content: { text: string }[] }).content[0].text;
  assert.match(kickoff, /^Implement Linear issue MET-42: Sidebar flickers on rename\nURL: https:\/\/linear\.app\/notefig\/issue\/MET-42\n/);
  assert.match(kickoff, /## Description\n\nThe tree jumps when I rename a file\./);
  assert.match(kickoff, /### Notefig Support\n\n### Debug report[\s\S]*=== Notefig Debug Report ===/);
  assert.match(kickoff, /### Parsa\n\nLooks like the tree re-renders\./);

  assert.deepEqual(comments, [
    {
      issueId: "issue-uuid",
      body: 'Agent started: https://platform.claude.com/workspaces/default/sessions/sesn_1. Its pull request will say "Closes MET-42", which links it here.',
    },
  ]);
});

test("starts it for an issue created already assigned to the agent", async () => {
  const { deps, sessions } = setup();
  await deliver(issueEvent({ action: "create", updatedFrom: undefined }), deps);
  assert.equal(sessions.length, 1);
});

test("ignores events that don't hand an accepted issue to the agent", async () => {
  const { deps, sessions } = setup();
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
  assert.equal(sessions.length, 0);
});

test("refuses unsigned, wrongly signed and stale deliveries", async () => {
  const { deps, sessions } = setup();
  const event = issueEvent();
  assert.equal((await deliver(event, deps, null)).status, 401);
  assert.equal((await deliver(event, deps, "zz")).status, 401);
  const body = JSON.stringify(event);
  assert.equal((await handleLinearWebhook(body, await sign(body, "other-secret"), deps)).status, 401);
  assert.equal((await deliver(issueEvent({ webhookTimestamp: NOW - 61_000 }), deps)).status, 401);
  assert.equal(sessions.length, 0);
});

test("answers 502 when the session won't start, so Linear retries", async () => {
  const { deps, comments } = setup(true);
  const response = await quietly(() => deliver(issueEvent(), deps));
  assert.equal(response.status, 502);
  assert.equal(comments.length, 0);
});

test("still reports started when only the comment fails", async () => {
  const { deps } = setup();
  deps.createComment = async () => {
    throw new Error("comment refused");
  };
  const response = await quietly(() => deliver(issueEvent(), deps));
  assert.deepEqual(await response.json(), { outcome: "started", sessionId: "sesn_1" });
});
