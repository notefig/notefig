/**
 * The widget's quiet line about its session (MET-284): what the session is
 * doing elsewhere, and how many prompts it was sent after this widget's
 * own ("working in pitch.md · 2 newer"). It sits under everything else on
 * the card, so a change here never moves what the user is reading, and it
 * stays out of the way: one muted line, no motion, the only color a still
 * dot when the session waits on the user. Nothing to say, no line.
 */
import { useTranslation } from "react-i18next";
import { usePromptWidgetHost } from "../host-context";
import { basename } from "../basename";
import type { AgentTaskRow } from "@notefig/shared/agent";
import type { SessionActivity } from "../state";

/** A face's footer: only a bound widget whose session is still there has
 *  one, and only a face that knows its session's activity (not the demo). */
export function SessionFooter({
  task,
  boundTaskId,
  display,
}: {
  task: AgentTaskRow | undefined;
  boundTaskId: string | null;
  display: { sessionActivity?: SessionActivity; newerCount?: number };
}) {
  if (!boundTaskId || !task || !display.sessionActivity) return null;
  return (
    <div contentEditable={false}>
      <SessionLine activity={display.sessionActivity} newer={display.newerCount ?? 0} />
    </div>
  );
}

function SessionLine({
  activity,
  newer,
}: {
  activity: SessionActivity;
  /** Prompts the session was sent after this widget's own. */
  newer: number;
}) {
  const { t } = useTranslation();
  const host = usePromptWidgetHost();
  const turnId =
    activity.kind === "working" || activity.kind === "needs-you" ? activity.turnId : null;
  // Unconditional: where the turn it is on came from, null for the chat.
  const document = host.useRoundDocument(turnId);
  const file = document ? basename(document) : null;

  const parts: string[] = [];
  if (activity.kind === "needs-you") {
    parts.push(
      file
        ? t("promptBlobSessionNeedsYouIn", { file })
        : t("promptBlobSessionNeedsYouInChat"),
    );
  } else if (activity.kind === "working") {
    parts.push(
      file
        ? t("promptBlobSessionWorkingIn", { file })
        : t("promptBlobSessionWorkingInChat"),
    );
  } else if (activity.kind === "queued") {
    parts.push(t("promptBlobSessionQueued", { count: activity.count }));
  }
  if (newer > 0) parts.push(t("promptBlobSessionNewer", { count: newer }));
  if (parts.length === 0) return null;

  return (
    <div
      className="flex h-5 min-w-0 items-center gap-1.5 px-2.5 pb-0.5 text-[0.6875rem] leading-4 text-muted-foreground"
      data-session-footer={activity.kind}
    >
      {activity.kind === "needs-you" && (
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warning" />
      )}
      <span className="min-w-0 truncate">{parts.join(" · ")}</span>
    </div>
  );
}
