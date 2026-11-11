/**
 * The widget's session, as one tag (MET-284): the session's mark, and what
 * the session is up to besides this widget, so one look says whose the
 * widget is and how that session stands: a still dot while it waits on the
 * user, "2 newer" for the prompts it was sent after this one (where it is
 * working is the tooltip's to say). The tag opens the session's chat. Its tooltip names
 * the harness (small, first) and the session, then says the status in
 * full; the session's name is never another title on the card.
 */
import { useTranslation } from "react-i18next";
import { cn } from "@notefig/ui/utils";
import { OpenInNewTabContextMenu } from "@notefig/ui/open-in-new-tab-item";
import { openIntentOf, type OpenIntent } from "@notefig/ui/open-intent";
import { Tooltip, TooltipContent, TooltipTrigger } from "@notefig/ui/tooltip";
import type { AgentTaskRow } from "@notefig/shared/agent";
import { usePromptWidgetHost } from "../host-context";
import { SessionMarkIcon } from "../session-mark";
import { useSessionStatusLine, type SessionStatus } from "./session-status";

/** What the tag shows of the session: its name, harness and mark. */
export type SessionMark = Pick<
  AgentTaskRow,
  "title" | "harnessId" | "colorSlot" | "shapeSlot"
>;

export function SessionTag({
  session,
  status,
  onOpenChat,
  className,
}: {
  /** The bound session, or undefined while its row is unknown. */
  session: SessionMark | undefined;
  /** What the session is up to besides this widget; none in the demo. */
  status?: SessionStatus;
  /** Open the session's chat. Absent: the tag holds its place, unseen. */
  onOpenChat?: (intent?: OpenIntent) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const kind = status?.activity.kind;
  const newer = status?.newer ?? 0;
  // Anything beside the mark widens the tag into a pill with room for it.
  const extra = kind === "needs-you" || newer > 0;
  const button = (
    <button
      type="button"
      aria-label={t("promptBlobOpenChat")}
      disabled={!onOpenChat}
      data-session-tag={kind ?? ""}
      data-session-newer={newer}
      className={cn(
        "flex shrink-0 items-center justify-center gap-1.5 rounded text-[0.625rem] leading-none text-muted-foreground tabular-nums transition-colors",
        extra ? "ps-0.5 pe-1.5" : "px-px",
        onOpenChat ? "cursor-pointer hover:bg-accent hover:text-foreground" : "invisible",
        className,
      )}
      onClick={(event) => onOpenChat?.(openIntentOf(event))}
    >
      {/* 16px: a touch over the card's 12px icons, so the shape reads. */}
      <SessionMarkIcon colorSlot={session?.colorSlot} shapeSlot={session?.shapeSlot} size={16} />
      {kind === "needs-you" && (
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warning" />
      )}
      {newer > 0 && <span>{t("promptBlobSessionNewer", { count: newer })}</span>}
    </button>
  );
  if (!onOpenChat) return button;
  return (
    <Tooltip>
      <OpenInNewTabContextMenu
        label={t("openInNewTab")}
        onOpenInNewTab={() => onOpenChat("new-tab")}
      >
        <TooltipTrigger asChild>{button}</TooltipTrigger>
      </OpenInNewTabContextMenu>
      <SessionTooltip
        harnessId={session?.harnessId}
        title={session?.title ?? t("promptBlobOpenChat")}
        status={status}
      />
    </Tooltip>
  );
}

/** A session's tooltip, wherever its mark stands for it: the harness's name
 *  small and muted, then the session's, then its status when it has one. */
export function SessionTooltip({
  harnessId,
  title,
  status,
}: {
  harnessId?: string;
  title: string;
  status?: SessionStatus;
}) {
  return (
    <TooltipContent side="top" className="flex flex-col gap-0.5 px-2 py-1 text-[0.6875rem]">
      <span className="flex items-baseline gap-1.5">
        {harnessId && <HarnessName harnessId={harnessId} />}
        <span>{title}</span>
      </span>
      {status && <StatusLine status={status} />}
    </TooltipContent>
  );
}

/** The harness's name, small and muted. Its own component so the harness
 *  list is only read while the tooltip is open. */
function HarnessName({ harnessId }: { harnessId: string }) {
  const harness = usePromptWidgetHost()
    .useHarnessList()
    .find((entry) => entry.id === harnessId);
  return (
    <span className="text-[0.625rem] text-muted-foreground">{harness?.label ?? harnessId}</span>
  );
}

/** The status sentence. Its own component so its lookup (where the
 *  session is working) only runs while the tooltip is open. */
function StatusLine({ status }: { status: SessionStatus }) {
  const line = useSessionStatusLine(status);
  return line ? <span className="text-muted-foreground">{line}</span> : null;
}
