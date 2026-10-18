import { parseAttachments, uploadScreenshots, type Screenshot } from "./attachments.ts";
import { json } from "./http.ts";
import type { CreateComment, CreateIssue, UploadFile } from "./linear.ts";

/**
 * `POST /v1/feedback`: the app's feedback dialog. A valid report becomes
 * an issue in MET's Triage, in the roadmap project, labelled Feedback.
 * The message is markdown and is filed as written.
 *
 * The description syncs to the public GitHub repo, so it carries only what
 * the user wrote, with each screenshot as a "[Screenshot N]" marker. The
 * screenshots, uploaded to Linear, and the debug report go in a top-level
 * comment, which Linear's GitHub sync doesn't copy (only the issue's
 * synced thread does).
 *
 * The body is JSON, or multipart: the same JSON as a `feedback` part, and
 * each screenshot as a file part named by its attachment id.
 */

export interface FeedbackConfig {
  teamId: string;
  triageStateId: string;
  projectId: string;
  feedbackLabelId: string;
}

export interface FeedbackDeps {
  createIssue: CreateIssue;
  createComment: CreateComment;
  uploadFile: UploadFile;
  config: FeedbackConfig;
}

const OSES = ["macos", "windows", "linux", "web"] as const;
const SEMVER = /^\d{1,4}\.\d{1,4}\.\d{1,6}(-[0-9A-Za-z.-]{1,20})?$/;
const MAX_MESSAGE = 5000;
const MAX_DEBUG_REPORT = 50_000;
const TITLE_LENGTH = 80;

interface Feedback {
  message: string;
  version: string;
  os: (typeof OSES)[number];
  debugReport?: string;
}

export async function submitFeedback(
  body: Blob,
  contentType: string | null,
  deps: FeedbackDeps,
): Promise<Response> {
  const submission = await readSubmission(body, contentType);
  const feedback = submission && parseFeedback(submission.fields);
  const attachments = submission && (await parseAttachments(submission.files));
  if (!feedback || !attachments) return json(400, { error: "Invalid feedback" });
  try {
    const { message, screenshots } = await uploadScreenshots(
      feedback.message,
      attachments,
      deps.uploadFile,
    );
    const issueId = await deps.createIssue(
      issueFor({ ...feedback, message }, screenshots.length, deps.config),
    );
    const note = privateNote(feedback.debugReport, screenshots);
    // Failing here leaves an issue without its private part; the 502 asks
    // for a retry, and a duplicate in Triage beats losing it without a word.
    if (note) await deps.createComment(issueId, note);
  } catch (error) {
    console.error("feedback: issue not created", error);
    return json(502, { error: "Could not file feedback" });
  }
  return json(202, { ok: true });
}

async function readSubmission(
  body: Blob,
  contentType: string | null,
): Promise<{ fields: unknown; files: Map<string, File> } | null> {
  try {
    if (!contentType?.startsWith("multipart/form-data")) {
      return { fields: JSON.parse(await body.text()), files: new Map() };
    }
    const form = await new Response(body, { headers: { "Content-Type": contentType } }).formData();
    const fields = form.get("feedback");
    if (typeof fields !== "string") return null;
    const files = new Map<string, File>();
    for (const [name, value] of form) {
      if (typeof value !== "string") files.set(name, value);
    }
    return { fields: JSON.parse(fields), files };
  } catch {
    return null;
  }
}

function parseFeedback(value: unknown): Feedback | null {
  if (typeof value !== "object" || value === null) return null;
  const { message, version, os, debugReport } = value as Record<string, unknown>;
  if (!OSES.includes(os as Feedback["os"])) return null;
  if (typeof version !== "string" || !SEMVER.test(version)) return null;
  if (typeof message !== "string") return null;
  const trimmed = message.trim();
  if (!trimmed || trimmed.length > MAX_MESSAGE) return null;
  if (debugReport !== undefined) {
    if (typeof debugReport !== "string" || debugReport.length > MAX_DEBUG_REPORT) return null;
  }
  return { os, version, message: trimmed, debugReport } as Feedback;
}

function issueFor(feedback: Feedback, screenshotCount: number, config: FeedbackConfig) {
  const firstLine = defuse(plainText(feedback.message.split("\n")[0]));
  const title =
    firstLine.length > TITLE_LENGTH ? `${firstLine.slice(0, TITLE_LENGTH - 1)}…` : firstLine;
  const kept = privateSummary(screenshotCount > 0, Boolean(feedback.debugReport));
  return {
    teamId: config.teamId,
    stateId: config.triageStateId,
    projectId: config.projectId,
    labelIds: [config.feedbackLabelId],
    title,
    description: [
      defuse(feedback.message),
      "",
      "---",
      `**Version:** ${feedback.version} · **OS:** ${feedback.os}`,
      "",
      "_Sent from the app's feedback dialog._",
      ...(kept ? ["", `_${kept} in a private comment in Linear._`] : []),
    ].join("\n"),
  };
}

function privateSummary(screenshots: boolean, debugReport: boolean): string | null {
  if (screenshots && debugReport) return "The screenshots and debug report are";
  if (screenshots) return "The screenshots are";
  return debugReport ? "The debug report is" : null;
}

/** What stays in Linear: the screenshots and the debug report, or nothing. */
function privateNote(debugReport: string | undefined, screenshots: readonly Screenshot[]): string | null {
  if (!debugReport && screenshots.length === 0) return null;
  const lines = ["_Private: comments outside the synced thread stay out of GitHub._"];
  if (screenshots.length > 0) {
    lines.push("", "### Screenshots");
    for (const { label, url } of screenshots) lines.push("", `**${label}**`, "", `![${label}](${url})`);
  }
  if (debugReport) lines.push("", "### Debug report", "", fenced(debugReport));
  return lines.join("\n");
}

/**
 * A markdown line as a title: no image or screenshot marker, no heading,
 * quote, list or task marker in front, a link as its text, no emphasis or
 * code marks. Underscores inside a word (snake_case) stay. A line that was
 * only markup falls back to "Feedback".
 */
function plainText(line: string): string {
  const text = line
    .replace(/!\[[^\]]*\]\([^)]*\)|\*\[Screenshot \d+\]\*/g, "")
    .replace(/^\s*(#{1,6}\s+|>\s*|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*~`]+|(?<!\w)_+|_+(?!\w)/g, "")
    .trim();
  return text || "Feedback";
}

/**
 * Breaks `@name` so an issue synced to GitHub can't mention anyone: a
 * zero-width space after the `@` keeps the text readable.
 */
function defuse(text: string): string {
  return text.replace(/@(?=\w)/g, "@​");
}

/**
 * The report in a code block whose fence is longer than any run of
 * backticks inside it, so the report can't close the block early. Inside
 * the block, `@name` and markdown stay inert.
 */
function fenced(text: string): string {
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}text\n${text}\n${fence}`;
}
