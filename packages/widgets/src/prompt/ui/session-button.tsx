/**
 * The widget's session, as one control (MET-284): a dot in the session's
 * color that opens its chat. Every widget of a session carries the same
 * color, so the dot is how the user tells sessions apart in the document;
 * the session's name is its tooltip, never another title on the card.
 */
import { useTranslation } from "react-i18next";
import { cn } from "@notefig/ui/utils";
import { OpenInNewTabContextMenu } from "@notefig/ui/open-in-new-tab-item";
import { openIntentOf, type OpenIntent } from "@notefig/ui/open-intent";
import type { AgentTaskRow } from "@notefig/shared/agent";
import { sessionColor } from "../session-color";

/** What the dot shows of the session: its name and its color. */
export type SessionMark = Pick<AgentTaskRow, "title" | "colorSlot">;

export function SessionButton({
  session,
  onOpenChat,
  className,
}: {
  /** The bound session, or undefined while its row is unknown. */
  session: SessionMark | undefined;
  /** Open the session's chat. Absent: the dot holds its place, unseen. */
  onOpenChat?: (intent?: OpenIntent) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const button = (
    <button
      type="button"
      title={session?.title ?? t("promptBlobOpenChat")}
      aria-label={t("promptBlobOpenChat")}
      disabled={!onOpenChat}
      data-session-dot={session?.colorSlot ?? ""}
      className={cn(
        "flex shrink-0 items-center justify-center rounded transition-colors",
        onOpenChat ? "cursor-pointer hover:bg-accent" : "invisible",
        className,
      )}
      onClick={(event) => onOpenChat?.(openIntentOf(event))}
    >
      <span
        aria-hidden
        className="size-2 rounded-full"
        style={{ background: sessionColor(session?.colorSlot) }}
      />
    </button>
  );
  if (!onOpenChat) return button;
  return (
    <OpenInNewTabContextMenu
      label={t("openInNewTab")}
      onOpenInNewTab={() => onOpenChat("new-tab")}
    >
      {button}
    </OpenInNewTabContextMenu>
  );
}
