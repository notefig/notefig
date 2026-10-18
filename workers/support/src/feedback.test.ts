import assert from "node:assert/strict";
import { test } from "node:test";
import { submitFeedback, type FeedbackDeps } from "./feedback.ts";
import type { IssueInput } from "./linear.ts";
import { validFeedback } from "./testing.ts";

function setup(
  createIssue?: FeedbackDeps["createIssue"],
  createComment?: FeedbackDeps["createComment"],
) {
  const issues: IssueInput[] = [];
  const comments: { issueId: string; body: string }[] = [];
  const deps: FeedbackDeps = {
    createIssue:
      createIssue ??
      (async (input) => {
        issues.push(input);
        return `issue-${issues.length}`;
      }),
    createComment:
      createComment ?? (async (issueId, body) => void comments.push({ issueId, body })),
    config: {
      teamId: "team",
      triageStateId: "triage",
      projectId: "roadmap",
      feedbackLabelId: "feedback",
    },
  };
  return { deps, issues, comments };
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
  assert.match(issues[0].description, /^The sidebar flickers when I rename a file\n\n---\n/);
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
    return "issue";
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
  assert.match(issue.description, /\nsecond line @\u200Bteam/);
});

test("keeps the debug report out of the synced description, in a private comment", async () => {
  const { deps, issues, comments } = setup();
  const debugReport = "=== Notefig Debug Report ===\n```\n@team ````\n=== End Debug Report ===";
  await submitFeedback({ ...validFeedback, debugReport }, deps);

  const { description } = issues[0];
  assert.ok(!description.includes("Notefig Debug Report"));
  assert.ok(description.endsWith("_The debug report is in a private comment in Linear._"));
  assert.equal(comments.length, 1);
  const [{ issueId, body }] = comments;
  assert.equal(issueId, "issue-1");
  // In a code block it can't close early.
  assert.match(body, /### Debug report\n\n`````text\n=== Notefig Debug Report ===/);
  assert.ok(body.endsWith("=== End Debug Report ===\n`````"));
});

test("adds no comment when there's nothing private", async () => {
  const { deps, issues, comments } = setup();
  await submitFeedback(validFeedback, deps);
  assert.ok(!issues[0].description.includes("Debug report"));
  assert.equal(comments.length, 0);
});

test("answers 502 when the private comment can't be added", async () => {
  const { deps } = setup(undefined, async () => {
    throw new Error("comment refused");
  });
  const quiet = console.error;
  console.error = () => {};
  try {
    const response = await submitFeedback({ ...validFeedback, debugReport: "report" }, deps);
    assert.equal(response.status, 502);
  } finally {
    console.error = quiet;
  }
});

test("files the message's markdown as written, with a plain-text title", async () => {
  const { deps, issues } = setup();
  const message = "## **Crash** on `save`\n\n- step one\n- step two";
  await submitFeedback({ ...validFeedback, message }, deps);
  assert.equal(issues[0].title, "Crash on save");
  assert.ok(issues[0].description.startsWith(`${message}\n\n---\n`));
});

test("titles a message whose first line is only markup as Feedback", async () => {
  const { deps, issues } = setup();
  await submitFeedback({ ...validFeedback, message: "#  \nbody" }, deps);
  assert.equal(issues[0].title, "Feedback");
});

test("titles with plain text: link text, no emphasis, snake_case kept", async () => {
  const { deps, issues } = setup();
  await submitFeedback({ ...validFeedback, message: "*Crash* on [save](https://example.com) in _my_file_ ~~now~~" }, deps);
  assert.equal(issues[0].title, "Crash on save in my_file now");
});
