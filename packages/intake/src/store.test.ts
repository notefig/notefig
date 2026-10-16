import { describe, expect, it } from "vitest";
import { createWorkflowStore, type AdmitInput } from "./store";
import { memoryStorage } from "./testing";

const limits = { submissionsPerDay: 3, perSubmitterPerDay: 2, blockAfterDeclines: 2 };

function setup(start = Date.UTC(2026, 9, 16, 12)) {
  const storage = memoryStorage();
  let now = start;
  const store = createWorkflowStore(storage, () => now);
  const advanceDays = (days: number) => {
    now += days * 86_400_000;
  };
  return { storage, store, advanceDays };
}

function input(overrides: Partial<AdmitInput> = {}): AdmitInput {
  return { submissionId: "sub_1", fingerprint: "fp1", submitter: "alice", limits, ...overrides };
}

describe("createWorkflowStore", () => {
  it("admits a new report and links it to its issue", async () => {
    const { store, storage } = setup();
    expect(await store.admit(input())).toEqual({ kind: "create" });
    await store.linkIssue("sub_1", "issue_1");
    expect(storage.keys()).toContain("v1:issue:issue_1");
  });

  it("treats a second submitter's identical report as a duplicate of the issue", async () => {
    const { store } = setup();
    await store.admit(input());
    await store.linkIssue("sub_1", "issue_1");
    expect(await store.admit(input({ submissionId: "sub_2", submitter: "bob" }))).toEqual({
      kind: "duplicate",
      issueId: "issue_1",
    });
  });

  it("drops a submitter repeating their own report", async () => {
    const { store } = setup();
    await store.admit(input());
    expect(await store.admit(input({ submissionId: "sub_2" }))).toEqual({ kind: "drop" });
  });

  it("limits each submitter per day, and lets them back the next day", async () => {
    const { store, advanceDays } = setup();
    await store.admit(input({ submissionId: "a", fingerprint: "a" }));
    await store.admit(input({ submissionId: "b", fingerprint: "b" }));
    expect(await store.admit(input({ submissionId: "c", fingerprint: "c" }))).toEqual({
      kind: "limited",
    });
    advanceDays(1);
    expect(await store.admit(input({ submissionId: "c", fingerprint: "c" }))).toEqual({
      kind: "create",
    });
  });

  it("limits new issues across submitters per day", async () => {
    const { store } = setup();
    for (const name of ["a", "b", "c"]) {
      await store.admit(input({ submissionId: name, fingerprint: name, submitter: name }));
    }
    expect(
      await store.admit(input({ submissionId: "d", fingerprint: "d", submitter: "d" })),
    ).toEqual({ kind: "limited" });
  });

  it("frees the fingerprint when issue creation is abandoned", async () => {
    const { store } = setup();
    await store.admit(input());
    await store.abandon("sub_1");
    expect(await store.admit(input({ submissionId: "sub_2", submitter: "bob" }))).toEqual({
      kind: "create",
    });
  });

  it("drops reports of a declined issue, and blocks a submitter after repeated declines", async () => {
    const { store, advanceDays } = setup();
    await store.admit(input());
    await store.linkIssue("sub_1", "issue_1");
    await store.resolve("issue_1", "declined");
    expect(await store.admit(input({ submissionId: "x", submitter: "bob" }))).toEqual({
      kind: "drop",
    });

    await store.admit(input({ submissionId: "sub_2", fingerprint: "fp2" }));
    await store.linkIssue("sub_2", "issue_2");
    await store.resolve("issue_2", "declined");
    advanceDays(1);
    expect(await store.admit(input({ submissionId: "sub_3", fingerprint: "fp3" }))).toEqual({
      kind: "drop",
    });
  });

  it("does not count a duplicate resolution against the submitter", async () => {
    const { store } = setup();
    for (const id of ["1", "2"]) {
      await store.admit(input({ submissionId: id, fingerprint: id }));
      await store.linkIssue(id, `issue_${id}`);
      await store.resolve(`issue_${id}`, "duplicate");
    }
    expect(await store.admit(input({ submissionId: "3", fingerprint: "3", limits: { ...limits, perSubmitterPerDay: 5 } }))).toEqual({ kind: "create" });
  });

  it("caps agent runs per day", async () => {
    const { store, advanceDays } = setup();
    expect(await store.reserveAgentRun(1)).toBe(true);
    expect(await store.reserveAgentRun(1)).toBe(false);
    advanceDays(1);
    expect(await store.reserveAgentRun(1)).toBe(true);
  });

  it("prunes day counters older than the window and keeps records", async () => {
    const { store, storage, advanceDays } = setup();
    await store.admit(input());
    advanceDays(10);
    await store.reserveAgentRun(5);
    await store.prune(7);
    const keys = storage.keys();
    expect(keys.filter((key) => key.startsWith("v1:count:"))).toEqual([
      "v1:count:2026-10-26:agent-runs",
    ]);
    expect(keys).toContain("v1:submission:sub_1");
  });
});
