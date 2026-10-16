import { describe, expect, it } from "vitest";
import { signHmacSha256Hex } from "./crypto";
import { handleLinearWebhook, type WebhookDeps } from "./linear-webhook";
import { createWorkflowStore } from "./store";
import { memoryStorage } from "./testing";
import { fakeLinear } from "./testing-linear";
import { workflows } from "./workflows";

const NOW = Date.UTC(2026, 9, 16, 12);
const APPROVER = "user-parsa";
const SECRET = "whsec";

function setup(agentRunsUsed = 0) {
  const linear = fakeLinear();
  const store = createWorkflowStore(memoryStorage(), () => NOW);
  const deps: WebhookDeps = {
    secret: SECRET,
    linear: linear.client,
    store: () => store,
    workflows,
    approverIds: [APPROVER],
    now: () => NOW,
  };
  const ready = (async () => {
    for (let i = 0; i < agentRunsUsed; i++) await store.reserveAgentRun(Infinity);
  })();
  const deliver = async (event: Record<string, unknown>, signature?: string) => {
    await ready;
    const body = JSON.stringify({ webhookTimestamp: NOW, ...event });
    return handleLinearWebhook(deps, body, signature ?? (await signHmacSha256Hex(SECRET, body)));
  };
  return { deliver, calls: linear.calls };
}

function moved(to: string, overrides: Record<string, unknown> = {}) {
  return {
    type: "Issue",
    action: "update",
    actor: { id: APPROVER },
    data: { id: "issue-1", stateId: to, labelIds: ["label-feedback", "label-bug"] },
    updatedFrom: { stateId: "state-triage" },
    ...overrides,
  };
}

describe("handleLinearWebhook", () => {
  it("rejects a bad signature", async () => {
    const { deliver } = setup();
    expect((await deliver(moved("state-todo"), "00")).status).toBe(401);
  });

  it("rejects a stale delivery", async () => {
    const { deliver } = setup();
    expect((await deliver(moved("state-todo", { webhookTimestamp: NOW - 120_000 }))).status).toBe(
      401,
    );
  });

  it("on Accept adds the agent label and the roadmap project", async () => {
    const { deliver, calls } = setup();
    const result = await deliver(moved("state-todo"));
    expect(result.body).toEqual({ outcome: "accepted" });
    expect(calls).toEqual([
      {
        op: "update",
        id: "issue-1",
        input: { addedLabelIds: ["label-agent-build"], projectId: "project-ga" },
      },
    ]);
  });

  it("past the day's agent cap only adds the project, and says so", async () => {
    const { deliver, calls } = setup(5);
    const result = await deliver(moved("state-backlog"));
    expect(result.body).toEqual({ outcome: "accepted-over-cap" });
    expect(calls.map((call) => call.op)).toEqual(["update", "comment"]);
    expect(calls[0]).toMatchObject({ input: { projectId: "project-ga" } });
  });

  it("records a Decline without writing to Linear", async () => {
    const { deliver, calls } = setup();
    expect((await deliver(moved("state-canceled"))).body).toEqual({ outcome: "declined" });
    expect(calls).toEqual([]);
  });

  it.each([
    ["someone other than an approver", { actor: { id: "user-someone" } }],
    ["an issue without the Feedback label", { data: { id: "issue-1", stateId: "state-todo", labelIds: ["label-bug"] } }],
    ["a move that did not start in Triage", { updatedFrom: { stateId: "state-backlog" } }],
    ["an update with no state change", { updatedFrom: { labelIds: [] } }],
    ["a move straight to Done", { data: { id: "issue-1", stateId: "state-done", labelIds: ["label-feedback"] } }],
    ["a comment event", { type: "Comment", action: "create" }],
  ])("ignores %s", async (_, overrides) => {
    const { deliver, calls } = setup();
    expect((await deliver(moved("state-todo", overrides))).body).toEqual({ outcome: "ignored" });
    expect(calls).toEqual([]);
  });
});
