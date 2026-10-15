/**
 * The "@" mention popup: its keyboard/selection state machine, its list, and
 * the document-scoped mount that hands both to the suggestion plugin.
 *
 * Two callers. The chat tab's standalone composer drives `useMentionSuggestion`
 * itself and renders the portal inline, because its editor is its own. A
 * document mounts `PromptMentionMenu` beside the editor instead: there the
 * suggestion plugin lives on the document (a draft is document content), and
 * it was constructed outside React with no host in scope — so the menu
 * registers the live service through mention-bridge.ts and the plugin's
 * stable forwarders read it at call time.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type {
  SuggestionKeyDownProps,
  SuggestionProps,
} from "@tiptap/suggestion";
import { cn } from "@notefig/ui/utils";
import { usePromptWidgetHost } from "../host-context";
import type { MentionCandidate } from "../host";
import { registerMentionService } from "./mention-bridge";
import { mentionRowKey, searchMentionRows, type MentionRow } from "./mention-rows";

export interface SuggestionPopupState {
  container: HTMLElement;
  items: MentionRow[];
  command: (row: MentionRow) => void;
}

export type SuggestionRenderer = () => {
  onStart: (props: SuggestionProps<MentionRow>) => void;
  onUpdate: (props: SuggestionProps<MentionRow>) => void;
  onKeyDown: (props: SuggestionKeyDownProps) => boolean;
  onExit: () => void;
};

type SuggestionKeyAction = "next" | "previous" | "pick" | "none";

function suggestionKeyAction(event: KeyboardEvent): SuggestionKeyAction {
  switch (event.key) {
    case "ArrowDown":
      return "next";
    case "ArrowUp":
      return "previous";
    case "Enter":
    case "Tab":
      return event.shiftKey ? "none" : "pick";
    default:
      return "none";
  }
}

/** The directory prefix for a row's combined one-line label — the file name
 *  stays whole and the path shrinks: nothing for root files, the full
 *  prefix up to two levels, first/…/last beyond that. */
function summarizeDirPrefix(item: MentionCandidate): string | null {
  if (item.relativePath === item.title) return null;
  const dirs = item.relativePath.slice(0, -(item.title.length + 1)).split("/");
  if (dirs.length <= 2) return `${dirs.join("/")}/`;
  return `${dirs[0]}/…/${dirs[dirs.length - 1]}/`;
}

/** A row's one-line label: its muted context (a file's directory, a
 *  directive's namespace), its name kept whole, and a directive's
 *  description trailing. */
function rowParts(item: MentionRow): { context: string | null; name: string; detail?: string } {
  if (item.kind === "file") {
    return { context: summarizeDirPrefix(item.file), name: item.file.title };
  }
  const { namespace, value, label, description } = item.directive;
  // A namespace reads as itself: "model:".
  if (value === null) return { context: null, name: label };
  return { context: `${namespace}: `, name: label, detail: description };
}

/** Icon and label, laid out alike for files and directives. */
function MentionRowLabel({ item }: { item: MentionRow }) {
  const { FileIcon, DirectiveIcon } = usePromptWidgetHost().slots;
  const { context, name, detail } = rowParts(item);
  const iconClass = "h-3.5 w-3.5 shrink-0 text-muted-foreground";
  return (
    <>
      {item.kind === "file" ? (
        <FileIcon path={item.file.path} className={iconClass} />
      ) : (
        <DirectiveIcon namespace={item.directive.namespace} className={iconClass} />
      )}
      {/* One combined label. A file keeps its name whole and its directory
          truncates first; a directive keeps its namespace whole — it says
          what the row is — and its name truncates. */}
      <span className="flex min-w-0 items-baseline" dir="ltr">
        {context && (
          <span
            className={cn(
              "whitespace-pre text-muted-foreground",
              item.kind === "file" ? "min-w-0 truncate" : "shrink-0",
            )}
          >
            {context}
          </span>
        )}
        <span className={item.kind === "file" ? "shrink-0" : "min-w-0 truncate"}>{name}</span>
        {detail && (
          // Gives way long before the name does.
          <span className="ms-1.5 min-w-0 shrink-[100] truncate text-muted-foreground">
            {detail}
          </span>
        )}
      </span>
    </>
  );
}

export function SuggestionList({
  items,
  selectedIndex,
  onPick,
  onHover,
}: {
  items: MentionRow[];
  selectedIndex: number;
  onPick: (index: number) => void;
  onHover: (index: number) => void;
}) {
  const { t } = useTranslation();
  /** Where the pointer last was over the list; none until it moves here. */
  const pointer = useRef<{ x: number; y: number } | null>(null);
  return (
    <div
      role="listbox"
      aria-label={t("mentionFilesLabel")}
      className="flex max-h-56 w-max min-w-36 max-w-72 flex-col overflow-y-auto rounded-md border bg-popover p-0.5 text-popover-foreground shadow-md texture-surface"
    >
      {items.map((item, index) => (
        <button
          key={mentionRowKey(item)}
          type="button"
          role="option"
          aria-selected={index === selectedIndex}
          // Mousedown, not click: the editor must not lose focus.
          onMouseDown={(event) => {
            event.preventDefault();
            onPick(index);
          }}
          // The pointer's own movement only. The browser follows a layout
          // change under a still pointer with a synthetic mousemove at the
          // same spot — taking it as a choice moved the selection to the
          // pointer's row a beat after each keystroke.
          onMouseMove={(event) => {
            const at = { x: event.clientX, y: event.clientY };
            const last = pointer.current;
            pointer.current = at;
            if (last && (last.x !== at.x || last.y !== at.y)) onHover(index);
          }}
          className={cn(
            "flex cursor-pointer items-center gap-1 rounded-sm px-1.5 py-0.5 text-start text-xs",
            index === selectedIndex && "bg-accent text-accent-foreground",
          )}
        >
          <MentionRowLabel item={item} />
        </button>
      ))}
    </div>
  );
}

/** The open popup's list, portalled into the container the suggestion
 *  plugin mounted; nothing while it has no rows. */
export function SuggestionPortal({
  popup,
  selectedIndex,
  pick,
  choose,
}: Pick<
  ReturnType<typeof useMentionSuggestion>,
  "popup" | "selectedIndex" | "pick" | "choose"
>) {
  if (!popup || popup.items.length === 0) return null;
  return createPortal(
    <SuggestionList
      items={popup.items}
      selectedIndex={selectedIndex}
      onPick={(index) => pick(popup, index)}
      onHover={(index) => choose(popup, index)}
    />,
    popup.container,
  );
}

/** The suggestion popup's state machine, out of the component so the
 *  plugin-facing callbacks (which close over the first render — live values
 *  ride in refs) stay separate from the editor wiring. */
export function useMentionSuggestion() {
  const [popup, setPopup] = useState<SuggestionPopupState | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const popupRef = useRef(popup);
  popupRef.current = popup;
  const selectedIndexRef = useRef(selectedIndex);
  selectedIndexRef.current = selectedIndex;
  const unmountPopup = useRef<(() => void) | null>(null);
  /** The row the user moved to (arrows, pointer), by key. It stays
   *  selected while typing narrows the list and still holds it; until then
   *  the selection is the top row, the best match. */
  const chosenKey = useRef<string | null>(null);

  const choose = useCallback((state: SuggestionPopupState, index: number) => {
    const item = state.items[index];
    if (!item) return;
    chosenKey.current = mentionRowKey(item);
    setSelectedIndex(index);
  }, []);

  const applySuggestion = useCallback(
    (props: SuggestionProps<MentionRow>) => {
      // The plugin announces each query twice: once while its rows load
      // (no items), then with them. The rows on screen stay until the new
      // ones arrive — emptying them in between tears the list down and back
      // up on every keystroke, resets the selection, and hands the keys to
      // the editor for that moment.
      if (props.loading) {
        setPopup((previous) => previous && { ...previous, command: props.command });
        return;
      }
      setPopup((previous) => {
        if (!previous) return previous;
        return { ...previous, items: props.items, command: props.command };
      });
      const kept = props.items.findIndex((item) => mentionRowKey(item) === chosenKey.current);
      if (kept === -1) chosenKey.current = null;
      setSelectedIndex(Math.max(kept, 0));
    },
    [],
  );

  const pick = useCallback((state: SuggestionPopupState, index: number) => {
    const item = state.items[index];
    if (item) state.command(item);
  }, []);

  const suggestionKeyDown = useCallback(
    ({ event }: SuggestionKeyDownProps): boolean => {
      const state = popupRef.current;
      if (!state || state.items.length === 0) return false;
      const action = suggestionKeyAction(event);
      if (action === "none") return false;
      if (action === "pick") pick(state, selectedIndexRef.current);
      else {
        const step = action === "next" ? 1 : -1;
        const count = state.items.length;
        choose(state, (selectedIndexRef.current + step + count) % count);
      }
      return true;
    },
    [pick, choose],
  );

  const renderer = useCallback<SuggestionRenderer>(
    () => ({
      onStart: (props) => {
        const container = document.createElement("div");
        container.className = "z-50";
        unmountPopup.current = props.mount?.(container) ?? null;
        setPopup({ container, items: props.items, command: props.command });
        chosenKey.current = null;
        setSelectedIndex(0);
      },
      onUpdate: applySuggestion,
      onKeyDown: suggestionKeyDown,
      onExit: () => {
        unmountPopup.current?.();
        unmountPopup.current = null;
        setPopup(null);
      },
    }),
    [applySuggestion, suggestionKeyDown],
  );

  return { popup, popupRef, selectedIndex, choose, pick, renderer };
}

/**
 * The popup for a document's prompt drafts. Mounted beside the editor (like
 * the link and table menus) because the suggestion plugin is registered on
 * the document, not on a per-widget editor — one menu serves every widget in
 * the file, since only one caret exists.
 */
export function PromptMentionMenu({
  documentPath,
  workspacePath,
}: {
  documentPath: string;
  workspacePath: string;
}) {
  const host = usePromptWidgetHost();
  const { popupRef, renderer, ...portal } = useMentionSuggestion();

  // One renderer instance for the plugin to drive, registered for as long as
  // this document's editor is on screen.
  const handlers = useRef<ReturnType<SuggestionRenderer> | null>(null);
  if (handlers.current === null) handlers.current = renderer();

  useEffect(() => {
    const live = handlers.current;
    if (!live) return;
    return registerMentionService(documentPath, {
      hasResults: () => (popupRef.current?.items.length ?? 0) > 0,
      // A draft's widget may be bound to its own session (the plugin says
      // which); an unbound one offers what the workspace's session, or a
      // new one, would.
      search: (query, { directives, taskId = null } = {}) =>
        searchMentionRows(host, { workspacePath, taskId, query, directives }),
      onStart: live.onStart,
      onUpdate: live.onUpdate,
      onKeyDown: live.onKeyDown,
      onExit: live.onExit,
    });
  }, [documentPath, workspacePath, host, popupRef]);

  return <SuggestionPortal {...portal} />;
}
