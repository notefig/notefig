/**
 * The widget's session, as one control (MET-284): the session's mark, which
 * opens its chat. Every widget of a session carries the same mark, so it is
 * how the user tells sessions apart in the document; the session's name is
 * its tooltip, never another title on the card.
 */
import { useTranslation } from "react-i18next";
import { cn } from "@notefig/ui/utils";
import { OpenInNewTabContextMenu } from "@notefig/ui/open-in-new-tab-item";
import { openIntentOf, type OpenIntent } from "@notefig/ui/open-intent";
import { Tooltip, TooltipContent, TooltipTrigger } from "@notefig/ui/tooltip";
import type { AgentTaskRow } from "@notefig/shared/agent";
import { SessionMarkIcon } from "../session-mark";

/** What the button shows of the session: its name and its mark. */
export type SessionMark = Pick<AgentTaskRow, "title" | "colorSlot" | "shapeSlot">;

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
      <SessionMarkIcon colorSlot={session?.colorSlot} shapeSlot={session?.shapeSlot} />
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
      <TooltipContent side="top" className="px-2 py-1 text-[0.6875rem]">
        {session?.title ?? t("promptBlobOpenChat")}
      </TooltipContent>
    </Tooltip>
  );
}
