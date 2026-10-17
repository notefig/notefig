import { json } from "./http.ts";
import type { CreateIssue } from "./linear.ts";

/**
 * `POST /v1/feedback`: the app's feedback dialog. A valid report becomes
 * an issue in MET's Triage, in the roadmap project, labelled Feedback
 * (plus Bug or Idea). Exact repeats and anything past the daily cap are
 * dropped quietly with the same 202, so a sender can't tell what's
 * filtered.
 */

export interface FeedbackConfig {
  teamId: string;
  triageStateId: string;
  projectId: string;
  labels: { feedback: string; bug: string; idea: string };
}

export interface FeedbackDeps {
  kv: Pick<KVNamespace, "get" | "put">;
  createIssue: CreateIssue;
  config: FeedbackConfig;
  now: () => number;
}

const KINDS = ["bug", "idea", "other"] as const;
const OSES = ["macos", "windows", "linux", "web"] as const;
const SEMVER = /^\d{1,4}\.\d{1,4}\.\d{1,6}(-[0-9A-Za-z.-]{1,20})?$/;
const MAX_MESSAGE = 5000;
const TITLE_LENGTH = 80;

export const DAILY_ISSUE_CAP = 50;
const DAY_SECONDS = 24 * 60 * 60;
const DUPLICATE_WINDOW_SECONDS = 7 * DAY_SECONDS;

interface Feedback {
  kind: (typeof KINDS)[number];
  message: string;
  version: string;
  os: (typeof OSES)[number];
}

export async function submitFeedback(body: unknown, deps: FeedbackDeps): Promise<Response> {
  const feedback = parseFeedback(body);
  if (!feedback) return json(400, { error: "Invalid feedback" });

  const duplicateKey = `feedback:dup:${await sha256(normalize(feedback.message))}`;
  const dayKey = `feedback:day:${new Date(deps.now()).toISOString().slice(0, 10)}`;
  if (await deps.kv.get(duplicateKey)) return json(202, { ok: true });
  const filedToday = Number((await deps.kv.get(dayKey)) ?? 0);
  if (filedToday >= DAILY_ISSUE_CAP) return json(202, { ok: true });

  try {
    await deps.createIssue(issueFor(feedback, deps.config));
  } catch (error) {
    console.error("feedback: issue not created", error);
    return json(502, { error: "Could not file feedback" });
  }
  // Two KV writes and no locking: a burst can overshoot the cap by a few
  // or file the same text twice, which Triage absorbs.
  await deps.kv.put(duplicateKey, "1", { expirationTtl: DUPLICATE_WINDOW_SECONDS });
  await deps.kv.put(dayKey, String(filedToday + 1), { expirationTtl: 2 * DAY_SECONDS });
  return json(202, { ok: true });
}

function parseFeedback(value: unknown): Feedback | null {
  if (typeof value !== "object" || value === null) return null;
  const { kind, message, version, os } = value as Record<string, unknown>;
  if (!KINDS.includes(kind as Feedback["kind"])) return null;
  if (!OSES.includes(os as Feedback["os"])) return null;
  if (typeof version !== "string" || !SEMVER.test(version)) return null;
  if (typeof message !== "string") return null;
  const trimmed = message.trim();
  if (!trimmed || trimmed.length > MAX_MESSAGE) return null;
  return { kind, os, version, message: trimmed } as Feedback;
}

function issueFor(feedback: Feedback, config: FeedbackConfig) {
  const { labels } = config;
  const kindLabel = { bug: [labels.bug], idea: [labels.idea], other: [] }[feedback.kind];
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
    labelIds: [labels.feedback, ...kindLabel],
    title,
    description: [
      quoted,
      "",
      "---",
      `**Kind:** ${feedback.kind} · **Version:** ${feedback.version} · **OS:** ${feedback.os}`,
      "",
      "_Sent from the app's feedback dialog._",
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

function normalize(message: string): string {
  return message.toLowerCase().replace(/\s+/g, " ");
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
