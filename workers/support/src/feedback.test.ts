import assert from "node:assert/strict";
import { test } from "node:test";
import { submitFeedback, type FeedbackDeps } from "./feedback.ts";
import type { IssueInput } from "./linear.ts";
import { validFeedback } from "./testing.ts";

function setup(createIssue?: FeedbackDeps["createIssue"]) {
  const issues: IssueInput[] = [];
  const deps: FeedbackDeps = {
    createIssue: createIssue ?? (async (input) => void issues.push(input)),
    config: {
      teamId: "team",
      triageStateId: "triage",
      projectId: "roadmap",
      feedbackLabelId: "feedback",
    },
  };
  return { deps, issues };
}

test("files feedback in Triage, in the roadmap project, labelled Feedback", async () => {
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
      labelIds: ["feedback"],
      title: "The sidebar flickers when I rename a file",
      description: undefined,
    },
  );
  assert.match(issues[0].description, /^> The sidebar flickers/);
  assert.match(issues[0].description, /\*\*Version:\*\* 0\.0\.146 · \*\*OS:\*\* macos/);
});

test("rejects malformed feedback without filing it", async () => {
  const { deps, issues } = setup();
  const invalid = [
    null,
    "text",
    { ...validFeedback, debugReport: 42 },
    { ...validFeedback, debugReport: "x".repeat(50_001) },
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

test("answers 502 when Linear fails, and files the same text on retry", async () => {
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

test("attaches the debug report in a code block it can't close early", async () => {
  const { deps, issues } = setup();
  const debugReport = "=== Notefig Debug Report ===\n```\n@team ````\n=== End Debug Report ===";
  await submitFeedback({ ...validFeedback, debugReport }, deps);
  const { description } = issues[0];
  assert.match(description, /### Debug report\n\n`````text\n=== Notefig Debug Report ===/);
  assert.ok(description.endsWith("=== End Debug Report ===\n`````"));
});

test("leaves the debug section out when no report is sent", async () => {
  const { deps, issues } = setup();
  await submitFeedback(validFeedback, deps);
  assert.ok(!issues[0].description.includes("Debug report"));
});
