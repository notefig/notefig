import assert from "node:assert/strict";
import { test } from "node:test";
import { submitFeedback, type FeedbackDeps } from "./feedback.ts";
import type { FileInput, IssueInput } from "./linear.ts";
import { validFeedback } from "./testing.ts";

function setup(overrides: Partial<Pick<FeedbackDeps, "createIssue" | "createComment" | "uploadFile">> = {}) {
  const issues: IssueInput[] = [];
  const comments: { issueId: string; body: string }[] = [];
  const uploads: FileInput[] = [];
  const deps: FeedbackDeps = {
    createIssue: async (input) => {
      issues.push(input);
      return `issue-${issues.length}`;
    },
    createComment: async (issueId, body) => void comments.push({ issueId, body }),
    uploadFile: async (file) => {
      uploads.push(file);
      return `https://uploads.linear.app/${file.filename}`;
    },
    config: {
      teamId: "team",
      triageStateId: "triage",
      projectId: "roadmap",
      feedbackLabelId: "feedback",
    },
    ...overrides,
  };
  return { deps, issues, comments, uploads };
}

/** A JSON body, as the app sends it without screenshots. */
const submit = (body: unknown, deps: FeedbackDeps) =>
  submitFeedback(new Blob([JSON.stringify(body)]), "application/json", deps);

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);

/** A multipart body: the feedback JSON plus a file part per screenshot. */
async function submitWithFiles(
  body: unknown,
  files: Record<string, { bytes: Uint8Array; type: string }>,
  deps: FeedbackDeps,
) {
  const form = new FormData();
  form.append("feedback", JSON.stringify(body));
  for (const [id, { bytes, type }] of Object.entries(files)) {
    form.append(id, new Blob([bytes], { type }), id);
  }
  const request = new Request("https://support.notefig.com", { method: "POST", body: form });
  return submitFeedback(await request.blob(), request.headers.get("Content-Type"), deps);
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

test("files feedback in Triage, in the roadmap project, labelled Feedback", async () => {
  const { deps, issues, comments } = setup();
  const response = await submit(validFeedback, deps);
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
  // Nothing private, so no comment and no mention of one.
  assert.equal(comments.length, 0);
  assert.ok(!issues[0].description.includes("private comment"));
});

test("rejects malformed feedback without filing it", async () => {
  const { deps, issues } = setup();
  const invalid = [
    null,
    "text",
    { ...validFeedback, os: "beos" },
    { ...validFeedback, version: "1.2" },
    { ...validFeedback, version: "@everyone" },
    { ...validFeedback, message: "   " },
    { ...validFeedback, message: "x".repeat(5001) },
    { ...validFeedback, debugReport: 42 },
    { ...validFeedback, debugReport: "x".repeat(50_001) },
  ];
  for (const body of invalid) {
    assert.equal((await submit(body, deps)).status, 400, JSON.stringify(body));
  }
  assert.equal(issues.length, 0);
});

test("answers 502 when Linear fails, and files the same text on retry", async () => {
  let fail = true;
  const { deps, issues } = setup();
  const createIssue = deps.createIssue;
  deps.createIssue = async (input) => {
    if (fail) throw new Error("Linear down");
    return createIssue(input);
  };
  assert.equal((await quietly(() => submit(validFeedback, deps))).status, 502);
  fail = false;
  assert.equal((await submit(validFeedback, deps)).status, 202);
  assert.equal(issues.length, 1);
});

test("defuses mentions and shortens long titles", async () => {
  const { deps, issues } = setup();
  const message = `@octocat ${"word ".repeat(30)}\nsecond line @team`;
  await submit({ ...validFeedback, message }, deps);
  const [issue] = issues;
  assert.equal(issue.title.length, 80);
  assert.ok(issue.title.endsWith("…"));
  assert.ok(!/@\w/.test(issue.title));
  assert.ok(!/@\w/.test(issue.description));
  assert.match(issue.description, /\nsecond line @​team/);
});

test("files the message's markdown as written, with a plain-text title", async () => {
  const { deps, issues } = setup();
  const message = "## **Crash** on `save`\n\n- step one\n- step two";
  await submit({ ...validFeedback, message }, deps);
  assert.equal(issues[0].title, "Crash on save");
  assert.ok(issues[0].description.startsWith(`${message}\n\n---\n`));
});

test("titles a message whose first line is only markup as Feedback", async () => {
  const { deps, issues } = setup();
  await submit({ ...validFeedback, message: "#  \nbody" }, deps);
  assert.equal(issues[0].title, "Feedback");
});

test("keeps the debug report out of the synced description, in a private comment", async () => {
  const { deps, issues, comments } = setup();
  const debugReport = "=== Notefig Debug Report ===\n```\n@team ````\n=== End Debug Report ===";
  await submit({ ...validFeedback, debugReport }, deps);

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

test("answers 502 when the private comment can't be added", async () => {
  const { deps } = setup({
    createComment: async () => {
      throw new Error("comment refused");
    },
  });
  const response = await quietly(() => submit({ ...validFeedback, debugReport: "report" }, deps));
  assert.equal(response.status, 502);
});

test("uploads screenshots into the private comment, leaving markers in the description", async () => {
  const { deps, issues, comments, uploads } = setup();
  const message = "![](attachment:img2)\nThe tree jumps\n\n![shot](attachment:img1)";
  const response = await submitWithFiles(
    { ...validFeedback, message },
    { img1: { bytes: JPEG, type: "image/jpeg" }, img2: { bytes: PNG, type: "image/png" } },
    deps,
  );
  assert.equal(response.status, 202);
  // In the order the message shows them.
  assert.deepEqual(
    uploads.map(({ filename, type }) => ({ filename, type })),
    [
      { filename: "screenshot-1.png", type: "image/png" },
      { filename: "screenshot-2.jpg", type: "image/jpeg" },
    ],
  );
  assert.deepEqual([...uploads[0].bytes], [...PNG]);

  const { title, description } = issues[0];
  assert.equal(title, "Feedback");
  assert.ok(description.startsWith("*[Screenshot 1]*\nThe tree jumps\n\n*[Screenshot 2]*\n"));
  assert.ok(!description.includes("uploads.linear.app"));
  assert.ok(description.endsWith("_The screenshots are in a private comment in Linear._"));

  const [{ body }] = comments;
  assert.match(
    body,
    /### Screenshots\n\n\*\*Screenshot 1\*\*\n\n!\[Screenshot 1\]\(https:\/\/uploads\.linear\.app\/screenshot-1\.png\)/,
  );
  assert.match(body, /!\[Screenshot 2\]\(https:\/\/uploads\.linear\.app\/screenshot-2\.jpg\)/);
});

test("puts screenshots and the debug report in the same private comment", async () => {
  const { deps, issues, comments } = setup();
  await submitWithFiles(
    { ...validFeedback, message: "Look ![](attachment:img1)", debugReport: "report" },
    { img1: { bytes: PNG, type: "image/png" } },
    deps,
  );
  assert.ok(
    issues[0].description.endsWith("_The screenshots and debug report are in a private comment in Linear._"),
  );
  assert.equal(comments.length, 1);
  assert.match(comments[0].body, /### Screenshots[\s\S]*### Debug report/);
});

test("doesn't upload a screenshot the message no longer shows, or keep a placeholder without one", async () => {
  const { deps, issues, uploads, comments } = setup();
  await submitWithFiles(
    { ...validFeedback, message: "Gone ![](attachment:img9)" },
    { img1: { bytes: PNG, type: "image/png" } },
    deps,
  );
  assert.equal(uploads.length, 0);
  assert.equal(comments.length, 0);
  assert.ok(issues[0].description.startsWith("Gone \n"));
});

test("refuses screenshots that aren't what they claim, or past the limits", async () => {
  const { deps, issues, uploads } = setup();
  const message = "![](attachment:img1)";
  const cases: Record<string, { bytes: Uint8Array; type: string }>[] = [
    { img1: { bytes: JPEG, type: "image/png" } },
    { img1: { bytes: PNG, type: "image/gif" } },
    { "../x": { bytes: PNG, type: "image/png" } },
    { img1: { bytes: new Uint8Array(2 * 1024 * 1024 + 1).fill(0x89), type: "image/png" } },
    Object.fromEntries(["a", "b", "c", "d"].map((id) => [id, { bytes: PNG, type: "image/png" }])),
  ];
  for (const files of cases) {
    const response = await submitWithFiles({ ...validFeedback, message }, files, deps);
    assert.equal(response.status, 400, Object.keys(files).join(","));
  }
  assert.equal(issues.length + uploads.length, 0);
});

test("answers 502, filing nothing, when a screenshot won't upload", async () => {
  const { deps, issues } = setup({
    uploadFile: async () => {
      throw new Error("upload down");
    },
  });
  const response = await quietly(() =>
    submitWithFiles(
      { ...validFeedback, message: "![](attachment:img1)" },
      { img1: { bytes: PNG, type: "image/png" } },
      deps,
    ),
  );
  assert.equal(response.status, 502);
  assert.equal(issues.length, 0);
});

test("titles with plain text: link text, no emphasis, snake_case kept", async () => {
  const { deps, issues } = setup();
  await submit({ ...validFeedback, message: "*Crash* on [save](https://example.com) in _my_file_ ~~now~~" }, deps);
  assert.equal(issues[0].title, "Crash on save in my_file now");
});
