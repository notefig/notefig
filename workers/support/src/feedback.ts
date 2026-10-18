import { json } from "./http.ts";
import type { CreateIssue } from "./linear.ts";

/**
 * `POST /v1/feedback`: the app's feedback dialog. A valid report becomes
 * an issue in MET's Triage, in the roadmap project, labelled Feedback,
 * with the app's debug report attached when the user chose to send it.
 */

export interface FeedbackConfig {
  teamId: string;
  triageStateId: string;
  projectId: string;
  feedbackLabelId: string;
}

export interface FeedbackDeps {
  createIssue: CreateIssue;
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

export async function submitFeedback(body: unknown, deps: FeedbackDeps): Promise<Response> {
  const feedback = parseFeedback(body);
  if (!feedback) return json(400, { error: "Invalid feedback" });
  try {
    await deps.createIssue(issueFor(feedback, deps.config));
  } catch (error) {
    console.error("feedback: issue not created", error);
    return json(502, { error: "Could not file feedback" });
  }
  return json(202, { ok: true });
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

function issueFor(feedback: Feedback, config: FeedbackConfig) {
  const firstLine = defuse(feedback.message.split("\n")[0].trim());
  const title =
    firstLine.length > TITLE_LENGTH ? `${firstLine.slice(0, TITLE_LENGTH - 1)}…` : firstLine;
  const quoted = defuse(feedback.message)
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return {
    teamId: config.teamId,
    stateId: config.triageStateId,
    projectId: config.projectId,
    labelIds: [config.feedbackLabelId],
    title,
    description: [
      quoted,
      "",
      "---",
      `**Version:** ${feedback.version} · **OS:** ${feedback.os}`,
      "",
      "_Sent from the app's feedback dialog._",
      ...(feedback.debugReport ? ["", "### Debug report", "", fenced(feedback.debugReport)] : []),
    ].join("\n"),
  };
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
