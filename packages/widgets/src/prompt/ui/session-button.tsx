/**
 * The widget's session, as one control (MET-284): the session's mark, which
 * opens its chat. Every widget of a session carries the same mark, so it is
 * how the user tells sessions apart in the document; the session's name (and
 * its harness's, smaller, before it) is its tooltip, never another title on
 * the card.
 */
import { useTranslation } from "react-i18next";
import { cn } from "@notefig/ui/utils";
import { OpenInNewTabContextMenu } from "@notefig/ui/open-in-new-tab-item";
import { openIntentOf, type OpenIntent } from "@notefig/ui/open-intent";
import { Tooltip, TooltipContent, TooltipTrigger } from "@notefig/ui/tooltip";
import type { AgentTaskRow } from "@notefig/shared/agent";
import { usePromptWidgetHost } from "../host-context";
import { SessionMarkIcon } from "../session-mark";

/** What the button shows of the session: its name, harness and mark. */
export type SessionMark = Pick<
  AgentTaskRow,
  "title" | "harnessId" | "colorSlot" | "shapeSlot"
>;

export function SessionButton({
  session,
  onOpenChat,
  className,
}: {
  /** The bound session, or undefined while its row is unknown. */
  session: SessionMark | undefined;
  /** Open the session's chat. Absent: the mark holds its place, unseen. */
  onOpenChat?: (intent?: OpenIntent) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const harness = usePromptWidgetHost()
    .useHarnessList()
    .find((entry) => entry.id === session?.harnessId);
  const button = (
    <button
      type="button"
      aria-label={t("promptBlobOpenChat")}
      disabled={!onOpenChat}
      className={cn(
        "flex shrink-0 items-center justify-center rounded transition-colors",
        onOpenChat ? "cursor-pointer hover:bg-accent" : "invisible",
        className,
      )}
      onClick={(event) => onOpenChat?.(openIntentOf(event))}
    >
      {/* 16px: a touch over the card's 12px icons, so the shape reads. */}
      <SessionMarkIcon colorSlot={session?.colorSlot} shapeSlot={session?.shapeSlot} size={16} />
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
      <TooltipContent side="top" className="flex items-baseline gap-1.5 px-2 py-1 text-[0.6875rem]">
        {harness && (
          <span className="text-[0.625rem] text-muted-foreground">{harness.label}</span>
        )}
        <span>{session?.title ?? t("promptBlobOpenChat")}</span>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The session's harness, as its secondary mark (MET-284): a quiet logo among
 * a settled widget's end buttons, its tooltip the harness's name. The
 * session's own mark leads the heading; this says which agent runs it.
 */
export function HarnessBadge({ harnessId }: { harnessId: string | undefined }) {
  const host = usePromptWidgetHost();
  const { HarnessLogo } = host.slots;
  const harness = host.useHarnessList().find((entry) => entry.id === harnessId);
  if (!harnessId) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="flex size-[1.125rem] shrink-0 items-center justify-center text-muted-foreground"
          data-harness-badge={harnessId}
        >
          <HarnessLogo harnessId={harnessId} className="size-3" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="px-2 py-1 text-[0.6875rem]">
        {harness?.label ?? harnessId}
      </TooltipContent>
    </Tooltip>
  );
}
