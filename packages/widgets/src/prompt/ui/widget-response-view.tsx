import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@notefig/ui/utils";
import { Checkbox } from "@notefig/ui/checkbox";
import {
  isChoiceKind,
  type WidgetResponse,
  type WidgetResponseKind,
} from "@notefig/shared/agent";
import { deriveDoneLine } from "../state";
import { usePromptWidgetHost } from "../host-context";
import { CopyTextButton } from "./copy-text-button";

/**
 * A `widget_respond` outcome as the reader sees it: the heading line (which
 * doubles as the collapse toggle), the copy button, and the markdown body.
 * The widget's done face and the chat's widget_respond card both render
 * this, so the answer reads the same in the document and in the transcript.
 * Placement-specific chrome comes in from the caller: `mark` leads the
 * heading row (the widget's harness logo, tinted here by the response's
 * kind), `actions` sit at its end, `children` below the body.
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
  mark,
  actions,
  children,
}: {
  response: WidgetResponse | null;
  fallbackText?: string | null;
  cancelled?: boolean;
  /** In a document the body IS the outcome, so it lands expanded (MET-133).
   *  The chat lands collapsed: the answer is one row among many there. */
  defaultExpanded?: boolean;
  mark?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const { Markdown } = usePromptWidgetHost().slots;
  // Component-local on purpose; a remount resets to the placement's
  // default, which is the desired landing state anyway.
  const [expanded, setExpanded] = useState(defaultExpanded);
  const { summary, body, kind } = deriveDoneLine({
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
  const isIssue = kind === "issue";
  const tinted = mark && (
    <span className={cn("flex shrink-0 items-center", KIND_TONES[kind])}>
      {mark}
    </span>
  );
  if (isChoiceKind(kind)) {
    return (
      <div
        className="flex flex-col gap-1 px-2 py-1"
        data-widget-response={kind}
      >
        <div className="flex items-start gap-1.5">
          {tinted && <span className="flex h-[1.125rem]">{tinted}</span>}
          {/* The question is the heading, wrapped rather than cut to one
              line: a question read up to an ellipsis can't be answered. */}
          <Markdown
            text={summary}
            className="max-h-40 min-w-0 flex-1 overflow-y-auto text-xs leading-relaxed text-foreground"
          />
          <CopyTextButton text={summary} className="p-0.5" iconClassName="size-3" />
          {actions}
        </div>
        {children}
      </div>
    );
  }
  return (
    <div
      className="flex flex-col gap-0.5 px-2 py-1"
      data-widget-response={response?.kind}
    >
      <div className="flex items-center gap-1.5">
        {tinted}
        <SummaryLine
          summary={summary}
          expandable={body !== null}
          expanded={expanded}
          kind={kind}
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
      {children}
    </div>
  );
}

/** Each response kind's tint for the heading's mark. */
const KIND_TONES: Record<WidgetResponseKind, string> = {
  answer: "text-success/80",
  issue: "text-warning",
  single_choice: "text-primary",
  multiple_choice: "text-primary",
};

/** A choice question's options as a record, not a control: the chat's card
 *  shows what was asked; the answer is the session's next prompt. */
export function ReadOnlyChoices({
  options,
  multiple,
}: {
  options: readonly string[];
  multiple: boolean;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-1.5 pt-0.5"
      data-choice-record={multiple ? "multiple" : "single"}
    >
      {options.map((option) => (
        <span key={option} className={choiceChipBaseClass}>
          {multiple && (
            <Checkbox
              disabled
              tabIndex={-1}
              className="size-3 rounded-[3px] disabled:cursor-default"
            />
          )}
          {option}
        </span>
      ))}
    </div>
  );
}

/** A choice chip's shape, shared by the widget's live options. */
export const choiceChipBaseClass =
  "flex items-center gap-1.5 rounded-md border border-border px-2 py-0.5 text-xs text-foreground/80";

function SummaryLine({
  summary,
  expandable,
  expanded,
  kind,
  onToggle,
}: {
  summary: string;
  expandable: boolean;
  expanded: boolean;
  kind: WidgetResponseKind;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const isIssue = kind === "issue";
  return (
    <>
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
