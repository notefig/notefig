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
  const { FileIcon } = usePromptWidgetHost().slots;
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
          onMouseEnter={() => onHover(index)}
          className={cn(
            "flex cursor-pointer items-center gap-1 rounded-sm px-1.5 py-0.5 text-start text-xs",
            index === selectedIndex && "bg-accent text-accent-foreground",
          )}
        >
          {item.kind === "file" ? (
            <>
              <FileIcon
                path={item.file.path}
                className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
              />
              {/* One combined label: the name stays whole, the dir summary
                  truncates first. */}
              <span className="flex min-w-0 items-baseline" dir="ltr">
                <span className="min-w-0 truncate text-muted-foreground">
                  {summarizeDirPrefix(item.file)}
                </span>
                <span className="shrink-0">{item.file.title}</span>
              </span>
            </>
          ) : item.directive.value === null ? (
            // A namespace reads as what picking it inserts: "@model:".
            <span className="shrink-0" dir="ltr">
              @{item.directive.label}
            </span>
          ) : (
            <span className="flex min-w-0 items-baseline gap-1" dir="ltr">
              <span className="shrink-0 text-muted-foreground">
                {item.directive.namespace}:
              </span>
              <span className="shrink-0">{item.directive.label}</span>
              {item.directive.description && (
                <span className="min-w-0 truncate text-muted-foreground">
                  {item.directive.description}
                </span>
              )}
            </span>
          )}
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
  setSelectedIndex,
}: Pick<
  ReturnType<typeof useMentionSuggestion>,
  "popup" | "selectedIndex" | "pick" | "setSelectedIndex"
>) {
  if (!popup || popup.items.length === 0) return null;
  return createPortal(
    <SuggestionList
      items={popup.items}
      selectedIndex={selectedIndex}
      onPick={(index) => pick(popup, index)}
      onHover={setSelectedIndex}
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

  const applySuggestion = useCallback(
    (props: SuggestionProps<MentionRow>) => {
      setPopup((previous) => {
        if (!previous) return previous;
        return { ...previous, items: props.items, command: props.command };
      });
      setSelectedIndex(0);
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
        setSelectedIndex(
          (index) => (index + step + state.items.length) % state.items.length,
        );
      }
      return true;
    },
    [pick],
  );

  const renderer = useCallback<SuggestionRenderer>(
    () => ({
      onStart: (props) => {
        const container = document.createElement("div");
        container.className = "z-50";
        unmountPopup.current = props.mount?.(container) ?? null;
        setPopup({ container, items: props.items, command: props.command });
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

  return { popup, popupRef, selectedIndex, setSelectedIndex, pick, renderer };
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
