import assert from "node:assert/strict";
import { test } from "node:test";
import { DAILY_ISSUE_CAP, submitFeedback, type FeedbackDeps } from "./feedback.ts";
import type { IssueInput } from "./linear.ts";
import { fakeKv, validFeedback } from "./testing.ts";

function setup(createIssue?: FeedbackDeps["createIssue"]) {
  const issues: IssueInput[] = [];
  const kv = fakeKv();
  const deps: FeedbackDeps = {
    kv,
    createIssue: createIssue ?? (async (input) => void issues.push(input)),
    config: {
      teamId: "team",
      triageStateId: "triage",
      projectId: "roadmap",
      labels: { feedback: "feedback", bug: "bug", idea: "idea" },
    },
    now: () => Date.parse("2026-10-16T12:00:00Z"),
  };
  return { deps, issues, kv };
}

test("files feedback in Triage, in the roadmap project, with its kind's label", async () => {
  const { deps, issues } = setup();
  const response = await submitFeedback(validFeedback, deps);
  assert.equal(response.status, 202);
  assert.equal(issues.length, 1);
  assert.deepEqual(
    { ...issues[0], description: undefined },
    {
      teamId: "team",
      stateId: "triage",
      projectId: "roadmap",
      labelIds: ["feedback", "bug"],
      title: "The sidebar flickers when I rename a file",
      description: undefined,
    },
  );
  assert.match(issues[0].description, /^> The sidebar flickers/);
  assert.match(issues[0].description, /\*\*Version:\*\* 0\.0\.146 · \*\*OS:\*\* macos/);
});

test("labels ideas as Idea and other feedback with Feedback alone", async () => {
  const { deps, issues } = setup();
  await submitFeedback({ ...validFeedback, kind: "idea", message: "An idea" }, deps);
  await submitFeedback({ ...validFeedback, kind: "other", message: "Something else" }, deps);
  assert.deepEqual(issues.map((issue) => issue.labelIds), [["feedback", "idea"], ["feedback"]]);
});

test("rejects malformed feedback without filing it", async () => {
  const { deps, issues } = setup();
  const invalid = [
    null,
    "text",
    { ...validFeedback, kind: "rant" },
    { ...validFeedback, os: "beos" },
    { ...validFeedback, version: "1.2" },
    { ...validFeedback, version: "@everyone" },
    { ...validFeedback, message: "   " },
    { ...validFeedback, message: "x".repeat(5001) },
  ];
  for (const body of invalid) {
    assert.equal((await submitFeedback(body, deps)).status, 400, JSON.stringify(body));
  }
  assert.equal(issues.length, 0);
});

test("files the same text once, ignoring case and spacing, for a week", async () => {
  const { deps, issues, kv } = setup();
  await submitFeedback(validFeedback, deps);
  const repeat = { ...validFeedback, message: "  the SIDEBAR flickers\nwhen I rename a file " };
  assert.equal((await submitFeedback(repeat, deps)).status, 202);
  assert.equal(issues.length, 1);
  const [duplicateKey] = [...kv.values.keys()].filter((key) => key.startsWith("feedback:dup:"));
  assert.equal(kv.ttls.get(duplicateKey), 7 * 24 * 60 * 60);
});

test("stops filing at the daily cap but still answers 202", async () => {
  const { deps, issues, kv } = setup();
  kv.values.set("feedback:day:2026-10-16", String(DAILY_ISSUE_CAP));
  assert.equal((await submitFeedback(validFeedback, deps)).status, 202);
  assert.equal(issues.length, 0);
});

test("counts each filed issue against the day, expiring the counter", async () => {
  const { deps, kv } = setup();
  await submitFeedback(validFeedback, deps);
  await submitFeedback({ ...validFeedback, message: "Another one" }, deps);
  assert.equal(kv.values.get("feedback:day:2026-10-16"), "2");
  assert.equal(kv.ttls.get("feedback:day:2026-10-16"), 2 * 24 * 60 * 60);
});

test("answers 502 when Linear fails, and lets the same text through on retry", async () => {
  let fail = true;
  const issues: IssueInput[] = [];
  const { deps } = setup(async (input) => {
    if (fail) throw new Error("Linear down");
    issues.push(input);
  });
  const quiet = console.error;
  console.error = () => {};
  try {
    assert.equal((await submitFeedback(validFeedback, deps)).status, 502);
  } finally {
    console.error = quiet;
  }
  fail = false;
  assert.equal((await submitFeedback(validFeedback, deps)).status, 202);
  assert.equal(issues.length, 1);
});

test("defuses mentions and shortens long titles", async () => {
  const { deps, issues } = setup();
  const message = `@octocat ${"word ".repeat(30)}\nsecond line @team`;
  await submitFeedback({ ...validFeedback, message }, deps);
  const [issue] = issues;
  assert.equal(issue.title.length, 80);
  assert.ok(issue.title.endsWith("…"));
  assert.ok(!/@\w/.test(issue.title));
  assert.ok(!/@\w/.test(issue.description));
  assert.match(issue.description, /> second line @​team/);
});
