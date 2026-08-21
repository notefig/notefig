import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import { FileTypeIcon } from "@/components/editor/file-type-icon";
import { useFileSearch, type FileSearchResult } from "@/hooks/use-file-search";
import {
  applyMention,
  getActiveMention,
  type ActiveMention,
} from "@/utils/prompt-mentions";
import { cn } from "@/lib/utils";

/**
 * @-mention file picker for the agent prompt composers (MET-80): blob
 * Composer, blob ReplyRow, and the chat tab's PromptBox all host the same
 * hook + popover around their plain textareas.
 *
 * The picker is a pure text affair — selecting a file inserts
 * `@<relativePath>` into the draft (see prompt-mentions.ts); the submit
 * paths re-extract mentions from the final text, so the picker holds no
 * state that must survive the dock unmounting a tab.
 *
 * Keyboard contract: the host textarea calls `handleKeyDown` FIRST in its
 * own onKeyDown and skips its normal key handling when it returns true.
 * While open, ArrowUp/Down navigate, Enter/Tab pick, Escape dismisses —
 * each preventDefault()s, which also makes the MET-94 global in-flight
 * Escape claim stand down (it bails on defaultPrevented events).
 */
export interface MentionPickerState {
  open: boolean;
  results: FileSearchResult[];
  selectedIndex: number;
  handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** Wire to the textarea's onSelect (fires on caret moves). */
  handleSelectionChange: () => void;
  pick: (result: FileSearchResult) => void;
  setSelectedIndex: (index: number) => void;
  /** Spread onto the host textarea: ref, value, onChange, onSelect. The
   *  host keeps its own onKeyDown (calling handleKeyDown first) and
   *  everything cosmetic. */
  textareaProps: {
    ref: RefObject<HTMLTextAreaElement>;
    value: string;
    onChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
    onSelect: () => void;
  };
}

const MENTION_LIMIT = 8;

export function useMentionPicker({
  workspacePath,
  value,
  onChange,
  textareaRef,
}: {
  workspacePath: string;
  value: string;
  onChange: (value: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement>;
}): MentionPickerState {
  const [active, setActive] = useState<ActiveMention | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  // The "@" index the user Escape-dismissed: that mention stays closed until
  // the caret leaves it or a different "@" becomes active.
  const [dismissedStart, setDismissedStart] = useState<number | null>(null);

  const recompute = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea || document.activeElement !== textarea) {
      setActive(null);
      return;
    }
    // Only a collapsed caret composes a mention.
    if (textarea.selectionStart !== textarea.selectionEnd) {
      setActive(null);
      return;
    }
    setActive(getActiveMention(textarea.value, textarea.selectionStart));
  }, [textareaRef]);

  // Caret position after a value change is only knowable post-render.
  useEffect(recompute, [value, recompute]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [active?.start, active?.query]);

  useEffect(() => {
    if (dismissedStart !== null && active?.start !== dismissedStart) {
      setDismissedStart(null);
    }
  }, [active, dismissedStart]);

  // Close when the textarea loses focus (onSelect doesn't fire on blur).
  // pick() suppresses the mousedown default, so choosing with the mouse
  // never blurs the textarea in the first place.
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const onBlur = () => setActive(null);
    textarea.addEventListener("blur", onBlur);
    return () => textarea.removeEventListener("blur", onBlur);
  }, [textareaRef]);

  const results = useFileSearch(workspacePath, active?.query ?? "", {
    limit: MENTION_LIMIT,
    matchAllWhenEmpty: true,
  });

  const open =
    active !== null && active.start !== dismissedStart && results.length > 0;

  const pick = useCallback(
    (result: FileSearchResult) => {
      const textarea = textareaRef.current;
      if (!textarea || !active) return;
      const applied = applyMention(
        textarea.value,
        active,
        textarea.selectionStart,
        result.relativePath,
      );
      onChange(applied.text);
      setActive(null);
      requestAnimationFrame(() => {
        textarea.focus();
        textarea.setSelectionRange(applied.caret, applied.caret);
      });
    },
    [textareaRef, active, onChange],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!open) return false;
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          setSelectedIndex((index) => (index + 1) % results.length);
          return true;
        case "ArrowUp":
          event.preventDefault();
          setSelectedIndex(
            (index) => (index - 1 + results.length) % results.length,
          );
          return true;
        case "Enter":
        case "Tab": {
          if (event.shiftKey) return false;
          event.preventDefault();
          const result = results[Math.min(selectedIndex, results.length - 1)];
          if (result) pick(result);
          return true;
        }
        case "Escape":
          event.preventDefault();
          if (active) setDismissedStart(active.start);
          return true;
        default:
          return false;
      }
    },
    [open, results, selectedIndex, pick, active],
  );

  const textareaProps = useMemo(
    () => ({
      ref: textareaRef,
      value,
      onChange: (event: ChangeEvent<HTMLTextAreaElement>) =>
        onChange(event.target.value),
      onSelect: recompute,
    }),
    [textareaRef, value, onChange, recompute],
  );

  return {
    open,
    results,
    selectedIndex,
    handleKeyDown,
    handleSelectionChange: recompute,
    pick,
    setSelectedIndex,
    textareaProps,
  };
}

/**
 * Wrap the host textarea: `<MentionPicker picker={picker}>{textarea}</...>`.
 * The popover anchors to the wrapper (not the caret — plain textareas have
 * no caret rect without a mirror div, and the composer card edge matches
 * the app's visual language), portals to body so overflow/pointer-events on
 * ancestors can't clip it, and never takes focus from the textarea.
 */
export function MentionPicker({
  picker,
  children,
  className,
}: {
  picker: MentionPickerState;
  children: ReactNode;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <Popover open={picker.open}>
      <PopoverAnchor asChild>
        <div className={className}>{children}</div>
      </PopoverAnchor>
      {picker.open && (
        <PopoverContent
          side="top"
          align="start"
          className="w-80 max-w-[90vw] p-1"
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <div
            role="listbox"
            aria-label={t("mentionFilesLabel")}
            className="flex max-h-64 flex-col overflow-y-auto"
          >
            {picker.results.map((result, index) => (
              <button
                key={result.path}
                type="button"
                role="option"
                aria-selected={index === picker.selectedIndex}
                // Mousedown, not click: the textarea must not lose focus.
                onMouseDown={(event) => {
                  event.preventDefault();
                  picker.pick(result);
                }}
                onMouseEnter={() => picker.setSelectedIndex(index)}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-start text-sm",
                  index === picker.selectedIndex &&
                    "bg-accent text-accent-foreground",
                )}
              >
                <FileTypeIcon
                  path={result.path}
                  className="h-4 w-4 shrink-0 text-muted-foreground"
                />
                <span className="truncate">{result.title}</span>
                {result.relativePath !== result.title && (
                  <span
                    className="ms-auto min-w-0 truncate text-xs text-muted-foreground"
                    dir="ltr"
                  >
                    {result.relativePath}
                  </span>
                )}
              </button>
            ))}
          </div>
        </PopoverContent>
      )}
    </Popover>
  );
}
