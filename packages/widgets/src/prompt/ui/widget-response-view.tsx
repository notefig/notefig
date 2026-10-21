import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, TriangleAlert } from "lucide-react";
import { cn } from "@notefig/ui/utils";
import type { WidgetResponse } from "@notefig/shared/agent";
import { deriveDoneLine } from "../state";
import { usePromptWidgetHost } from "../host-context";
import { CopyTextButton } from "./copy-text-button";

/**
 * A `widget_respond` outcome as the reader sees it: the heading line (which
 * doubles as the collapse toggle), the copy button, and the markdown body.
 * The widget's done face and the chat's widget_respond card both render
 * this, so the answer reads the same in the document and in the transcript.
 * Placement-specific chrome comes in from the caller: `actions` sit at the
 * end of the heading row, `children` below the body.
 *
 * When the response carries `options` (MET-250), they render below the body.
 * With an `onChooseOption` handler (the document's done face) they are
 * buttons — clicking one sends that label back as the user's next prompt;
 * without one (the chat transcript, where the composer is the reply
 * surface) they render as plain chips.
 *
 * The content prefers the response and falls back to `fallbackText` (the
 * turn's last assistant text), so a harness that never calls the tool still
 * leaves something readable behind.
 */
export function WidgetResponseView({
  response,
  fallbackText = null,
  cancelled = false,
  defaultExpanded = true,
  actions,
  onChooseOption,
  children,
}: {
  response: WidgetResponse | null;
  fallbackText?: string | null;
  cancelled?: boolean;
  /** In a document the body IS the outcome, so it lands expanded (MET-133).
   *  The chat lands collapsed: the answer is one row among many there. */
  defaultExpanded?: boolean;
  actions?: ReactNode;
  /** Send a clicked option back as the user's next prompt. Absent in the
   *  chat transcript, where options render as read-only chips. */
  onChooseOption?: (option: string) => void;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const { Markdown } = usePromptWidgetHost().slots;
  // Component-local on purpose; a remount resets to the placement's
  // default, which is the desired landing state anyway.
  const [expanded, setExpanded] = useState(defaultExpanded);
  const { summary, body, isIssue } = deriveDoneLine({
    response,
    fallbackText,
    cancelled,
    expanded,
    labels: {
      done: t("promptBlobDone"),
      stopped: t("promptBlobStopped"),
      issue: t("promptBlobIssue"),
    },
  });
  const options = response?.options ?? [];
  return (
    <div
      className="flex flex-col gap-0.5 px-2 py-1"
      data-widget-response={response?.kind}
    >
      <div className="flex items-center gap-1.5">
        <SummaryLine
          summary={summary}
          expandable={body !== null}
          expanded={expanded}
          isIssue={isIssue}
          onToggle={() => setExpanded((value) => !value)}
        />
        {body && (
          <CopyTextButton
            text={body}
            className="p-0.5"
            iconClassName="size-3"
          />
        )}
        {actions}
      </div>
      {expanded && body && (
        <Markdown
          text={body}
          className={cn(
            // Deliberately not `select-text`: in a document the response is
            // the widget's chrome, and opting it into selection is what let a
            // ⌘A over the prose paint it. The copy button in the heading row
            // is how this text leaves the card.
            "text-xs leading-relaxed",
            // Scroll cap: brevity is steered on the agent side (the
            // widget_respond directive), but a runaway response must scroll
            // inside the card, not swallow the document or the transcript.
            "max-h-80 overflow-y-auto",
            // Issue text mirrors ErrorState's uniform tinted text, in amber
            // — the card border (blobCardClass) carries the rest; no filled
            // callout box.
            isIssue ? "text-warning" : "text-foreground/80",
          )}
        />
      )}
      {expanded && options.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-1 pt-0.5"
          data-widget-response-options=""
        >
          {options.map((option, index) =>
            onChooseOption ? (
              <button
                key={`${index}:${option}`}
                type="button"
                className={cn(
                  optionChipClass,
                  "cursor-pointer border border-border bg-card text-foreground/80",
                  "transition-colors hover:bg-accent hover:text-foreground",
                )}
                onClick={() => onChooseOption(option)}
              >
                {option}
              </button>
            ) : (
              <span key={`${index}:${option}`} className={optionChipClass}>
                {option}
              </span>
            ),
          )}
        </div>
      )}
      {children}
    </div>
  );
}

const optionChipClass =
  "max-w-full truncate rounded-md px-1.5 py-0.5 text-[0.6875rem]";

function SummaryLine({
  summary,
  expandable,
  expanded,
  isIssue,
  onToggle,
}: {
  summary: string;
  expandable: boolean;
  expanded: boolean;
  isIssue: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      {isIssue ? (
        <TriangleAlert className="size-3 shrink-0 text-warning" />
      ) : (
        <Check className="size-3 shrink-0 text-success/80" />
      )}
      <button
        type="button"
        disabled={!expandable}
        title={
          expandable
            ? expanded
              ? t("promptBlobShowLess")
              : t("promptBlobShowMore")
            : undefined
        }
        className={cn(
          "min-w-0 flex-1 truncate text-left text-xs",
          isIssue ? "text-warning" : "text-muted-foreground",
          expandable &&
            "cursor-pointer transition-colors hover:text-foreground",
        )}
        onClick={onToggle}
      >
        {summary}
      </button>
    </>
  );
}
