import { describe, expect, it } from "vitest";
import { createWorkflowStore, type AdmitInput } from "./store";
import { memoryStorage } from "./testing";

const limits = {
  submissionsPerDay: 3,
  perSubmitterPerDay: 2,
  blockAfterDeclines: 2,
  duplicatesPerDay: 2,
};

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
      submissionId: "sub_1",
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

  it("caps builds from accepted issues per day", async () => {
    const { store, advanceDays } = setup();
    expect(await store.reserveBuild("issue_a", 1)).toBe(true);
    expect(await store.reserveBuild("issue_b", 1)).toBe(false);
    advanceDays(1);
    expect(await store.reserveBuild("issue_b", 1)).toBe(true);
  });

  it("reuses an issue's build slot when its Accept is delivered again", async () => {
    const { store } = setup();
    await store.admit(input());
    await store.linkIssue("sub_1", "issue_1");
    expect(await store.reserveBuild("issue_1", 1)).toBe(true);
    expect(await store.reserveBuild("issue_1", 1)).toBe(true);
    expect(await store.reserveBuild("issue_other", 1)).toBe(false);
  });

  it("caps duplicate reports per day across submitters", async () => {
    const { store } = setup();
    await store.admit(input());
    await store.linkIssue("sub_1", "issue_1");
    for (const name of ["b", "c"]) {
      expect(await store.admit(input({ submissionId: name, submitter: name }))).toMatchObject({
        kind: "duplicate",
      });
    }
    expect(await store.admit(input({ submissionId: "d", submitter: "d" }))).toEqual({ kind: "drop" });
  });

  it("frees the fingerprint of a submission interrupted before its issue was made", async () => {
    const { store, advanceDays } = setup();
    await store.admit(input());
    expect(await store.admit(input({ submissionId: "b", submitter: "bob" }))).toMatchObject({
      kind: "duplicate",
    });
    advanceDays(1 / 24);
    expect(await store.admit(input({ submissionId: "c", submitter: "carol" }))).toEqual({
      kind: "create",
    });
  });

  it("keeps a report until its issue is declined", async () => {
    const { store } = setup();
    await store.admit(input());
    await store.linkIssue("sub_1", "issue_1");
    const reportId = await store.saveReport("sub_1", "=== Notefig Debug Report ===");
    expect(reportId).toMatch(/^20261016-/);
    expect(await store.report(reportId)).toMatchObject({ text: "=== Notefig Debug Report ===" });
    await store.resolve("issue_1", "accepted");
    expect(await store.report(reportId)).toBeDefined();
    await store.resolve("issue_1", "declined");
    expect(await store.report(reportId)).toBeUndefined();
  });

  it("deletes a report when its issue couldn't be created", async () => {
    const { store } = setup();
    await store.admit(input());
    const reportId = await store.saveReport("sub_1", "report");
    await store.abandon("sub_1");
    expect(await store.report(reportId)).toBeUndefined();
  });

  it("reads only well-formed report ids", async () => {
    const { store } = setup();
    expect(await store.report("../v1:submission:sub_1")).toBeUndefined();
  });

  it("prunes day counters and reports older than their windows, and keeps records", async () => {
    const { store, storage, advanceDays } = setup();
    await store.admit(input());
    const oldReport = await store.saveReport("sub_1", "old");
    advanceDays(10);
    await store.reserveBuild("issue_x", 5);
    const newReport = await store.saveReport("sub_1", "new");
    await store.prune({ counterDays: 7, reportDays: 5 });
    const keys = storage.keys();
    expect(keys.filter((key) => key.startsWith("v1:count:"))).toEqual([
      "v1:count:2026-10-26:builds",
    ]);
    expect(await store.report(oldReport)).toBeUndefined();
    expect(await store.report(newReport)).toBeDefined();
    expect(keys).toContain("v1:submission:sub_1");
  });
});
