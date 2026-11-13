/**
 * What a widget's session is up to besides this widget (MET-284), as one
 * line for its tag's tooltip: where it is working or waiting on the user,
 * how many prompts are queued, and how many it was sent after this widget's
 * own ("working in pitch.md · 2 newer"). The tag itself shows the count and
 * a still dot; this is the whole sentence.
 */
import { useTranslation } from "react-i18next";
import { usePromptWidgetHost } from "../host-context";
import { basename } from "../basename";
import type { SessionActivity } from "../state";

/** The session's activity apart from this widget's own round, and how many
 *  prompts it was sent after this widget's. */
export interface SessionStatus {
  activity: SessionActivity;
  newer: number;
}

/** The status as a sentence, or null when there is nothing to say. Calls
 *  its host hook unconditionally: pass undefined for no status. */
export function useSessionStatusLine(status: SessionStatus | undefined): string | null {
  const { t } = useTranslation();
  // Where the turn the session is on came from; null for the chat.
  const document = usePromptWidgetHost().useRoundDocument(turnOf(status?.activity));
  if (!status) return null;
  const parts = [
    activityPhrase(t, status.activity, document),
    status.newer > 0 ? t("promptBlobSessionNewer", { count: status.newer }) : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** The turn an activity is on, when it names one. */
function turnOf(activity: SessionActivity | undefined): string | null {
  return activity?.kind === "working" || activity?.kind === "needs-you"
    ? activity.turnId
    : null;
}

/** Each place-bound activity's phrase: in a document, or in the chat. */
const PLACED_PHRASES = {
  "needs-you": ["promptBlobSessionNeedsYouIn", "promptBlobSessionNeedsYouInChat"],
  working: ["promptBlobSessionWorkingIn", "promptBlobSessionWorkingInChat"],
} as const;

type Translate = ReturnType<typeof useTranslation>["t"];

function activityPhrase(
  t: Translate,
  activity: SessionActivity,
  document: string | null,
): string | null {
  if (activity.kind === "queued") return t("promptBlobSessionQueued", { count: activity.count });
  if (activity.kind !== "working" && activity.kind !== "needs-you") return null;
  const [inFile, inChat] = PLACED_PHRASES[activity.kind];
  return document ? t(inFile, { file: basename(document) }) : t(inChat);
}
