import { describe, expect, it } from "vitest";
import type { BuildRequest } from "./build-queue";
import { signHmacSha256Hex } from "./crypto";
import { handleLinearWebhook, type WebhookDeps } from "./linear-webhook";
import { createWorkflowStore } from "./store";
import { memoryStorage } from "./testing";
import { fakeLinear } from "./testing-linear";
import { workflows } from "./workflows";
import { feedbackWorkflow } from "./workflows/feedback";

const NOW = Date.UTC(2026, 9, 16, 12);
const APPROVER = "user-parsa";
const SECRET = "whsec";

function setup(buildsUsed = 0) {
  const linear = fakeLinear();
  const store = createWorkflowStore(memoryStorage(), () => NOW);
  const builds: BuildRequest[] = [];
  const deps: WebhookDeps = {
    secret: SECRET,
    linear: linear.client,
    store: () => store,
    builds: {
      async request(request) {
        if (builds.some((build) => build.issueId === request.issueId)) return "already";
        builds.push(request);
        return builds.length === 1 ? "started" : "queued";
      },
    },
    workflows,
    approverIds: [APPROVER],
    now: () => NOW,
  };
  const ready = (async () => {
    // issue-1 is a feedback submission's issue, as the Worker filed it.
    await store.admit({ submissionId: "sub_1", fingerprint: "fp", limits: feedbackWorkflow.limits });
    await store.linkIssue("sub_1", "issue-1");
    for (let i = 0; i < buildsUsed; i++) await store.reserveBuild(`used-${i}`, Infinity);
  })();
  const deliver = async (event: Record<string, unknown>, signature?: string) => {
    await ready;
    const body = JSON.stringify({ webhookTimestamp: NOW, ...event });
    return handleLinearWebhook(deps, body, signature ?? (await signHmacSha256Hex(SECRET, body)));
  };
  return { deliver, calls: linear.calls, builds };
}

function labeled(labelIds: string[], before: string[], overrides: Record<string, unknown> = {}) {
  return {
    type: "Issue",
    action: "update",
    actor: { id: APPROVER },
    data: { id: "issue-7", stateId: "state-todo", labelIds },
    updatedFrom: { labelIds: before },
    ...overrides,
  };
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

  it("on Accept adds the agent label and the roadmap project, and starts a build", async () => {
    const { deliver, calls, builds } = setup();
    const result = await deliver(moved("state-todo"));
    expect(result.body).toEqual({ outcome: "accepted" });
    expect(calls).toEqual([
      {
        op: "update",
        id: "issue-1",
        input: { addedLabelIds: ["label-agent-build"], projectId: "project-ga" },
      },
    ]);
    expect(builds).toEqual([{ issueId: "issue-1", identifier: "MET-issue-1" }]);
  });

  it("past the day's cap for accepted feedback only adds the project, and says so", async () => {
    const { deliver, calls, builds } = setup(20);
    const result = await deliver(moved("state-backlog"));
    expect(result.body).toEqual({ outcome: "accepted-over-cap" });
    expect(calls.map((call) => call.op)).toEqual(["update", "comment"]);
    expect(calls[0]).toMatchObject({ input: { projectId: "project-ga" } });
    expect(builds).toEqual([]);
  });

  it("starts a build when an approver adds agent:build to any issue", async () => {
    const { deliver, builds } = setup();
    const result = await deliver(labeled(["label-bug", "label-agent-build"], ["label-bug"]));
    expect(result.body).toEqual({ outcome: "build-started" });
    expect(builds).toEqual([{ issueId: "issue-7", identifier: "MET-issue-7" }]);
  });

  it("starts a build for an issue created with agent:build (the template)", async () => {
    const { deliver, builds } = setup();
    const created = labeled(["label-agent-build"], [], { action: "create", updatedFrom: undefined });
    expect((await deliver(created)).body).toEqual({ outcome: "build-started" });
    expect(builds).toHaveLength(1);
  });

  it("doesn't cap builds an approver starts", async () => {
    const { deliver } = setup(20);
    const result = await deliver(labeled(["label-agent-build"], []));
    expect(result.body).toEqual({ outcome: "build-started" });
  });

  it("reuses the build slot when the same Accept is delivered again", async () => {
    const { deliver, builds } = setup(19);
    expect((await deliver(moved("state-todo"))).body).toEqual({ outcome: "accepted" });
    expect((await deliver(moved("state-todo"))).body).toEqual({ outcome: "accepted" });
    expect(builds).toHaveLength(1);
  });

  it("asks once when its own label change on Accept comes back", async () => {
    const { deliver, builds } = setup();
    await deliver(moved("state-todo"));
    const echo = labeled(["label-feedback", "label-agent-build"], ["label-feedback"], {
      data: { id: "issue-1", stateId: "state-todo", labelIds: ["label-feedback", "label-agent-build"] },
    });
    expect((await deliver(echo)).body).toEqual({ outcome: "build-already" });
    expect(builds).toHaveLength(1);
  });

  it.each([
    ["someone other than an approver", labeled(["label-agent-build"], [], { actor: { id: "user-someone" } })],
    ["a label change that keeps agent:build", labeled(["label-agent-build", "label-bug"], ["label-agent-build"])],
    ["a label change without agent:build", labeled(["label-bug"], [])],
    ["an edit that isn't a label change", labeled(["label-agent-build"], [], { updatedFrom: { title: "old" } })],
  ])("starts no build for %s", async (_, event) => {
    const { deliver, builds } = setup();
    expect((await deliver(event)).body).toEqual({ outcome: "ignored" });
    expect(builds).toEqual([]);
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
