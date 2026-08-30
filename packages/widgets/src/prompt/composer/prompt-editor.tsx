import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import { mergeAttributes, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import Mention from "@tiptap/extension-mention";
import type {
  SuggestionKeyDownProps,
  SuggestionProps,
} from "@tiptap/suggestion";
import { cn } from "@notefig/ui/utils";
import { usePromptWidgetHost } from "../host-context";
import type { MentionCandidate, PromptWidgetHost } from "../host";

/**
 * The agent prompt composer (MET-80): a single-line-feel Tiptap editor
 * replacing the plain textareas in the prompt blob, its reply row, and the
 * chat tab. Typing "@" opens the file-mention suggestion (Tiptap's
 * Suggestion plugin: caret-anchored floating-ui positioning, IME safety);
 * picking inserts an atomic mention chip — arrow keys skip it, one
 * Backspace deletes it and restores the "@" so the popup reopens.
 *
 * The value contract stays a plain string: chips serialize to the exact
 * `@<relativePath>` text the submit paths already re-parse
 * (prompt-mentions.ts), and setting a draft string revives chips for every
 * token that resolves to a real file (segmentMentions). Hosts keep their
 * own key maps via `onKeyDown` — it runs before the editor's handling
 * except while the suggestion popup is open, when the popup owns
 * Arrows/Enter/Tab/Escape.
 *
 * Adding more cues later (e.g. "/" commands) means appending an entry to
 * the Mention extension's `suggestions` array — the popup and keyboard
 * wiring are already per-trigger.
 */
export interface PromptEditorHandle {
  /** Focus the composer, caret at the end. False when it can't take focus
   *  (not mounted, destroyed, or disabled while a session loads) — callers
   *  going through the focus arbiter retry until it can. */
  focus: () => boolean;
}

interface SuggestionPopupState {
  container: HTMLElement;
  items: MentionCandidate[];
  command: (attrs: { id: string; label: string }) => void;
}

// ─── The mention text contract ──────────────────────────────────────────
// Mentions are stateless text: picking a file inserts a literal
// `@<relative/path>` (as an atomic chip that serializes to the same text),
// and submit paths re-scan the final string for tokens that resolve to real
// workspace files. Nothing persists alongside drafts, and hand-typed or
// edited mentions behave identically to picked ones. Paths containing
// spaces resolve too: extraction probes multi-word candidates, longest
// first — gated to candidates whose last word has an extension dot or that
// end the line, so following prose can never extend a mention into an
// unintended longer filename.

// A mention can't run past its line, and candidate probing is bounded so a
// long prose line doesn't test dozens of prefixes per "@". Paths with more
// space-separated words than this don't resolve — at 16, far past any real
// filename.
const MAX_MENTION_WORDS = 16;

const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"`]+$/;

/** The line's word-boundary prefixes after an "@" — the strings a mention
 *  could be, shortest first. */
function mentionCandidates(rest: string): string[] {
  const candidates: string[] = [];
  const word = /\S+/g;
  let match: RegExpExecArray | null;
  while ((match = word.exec(rest)) && candidates.length < MAX_MENTION_WORDS) {
    candidates.push(rest.slice(0, match.index + match[0].length));
  }
  return candidates;
}

/** Multi-word candidates must look like a filename (extension dot in the
 *  last word) or consume the whole line — otherwise prose after a picked
 *  mention could combine into some other real file's name. */
function isPlausibleMention(candidate: string, rest: string): boolean {
  if (!/\s/.test(candidate)) return true;
  if (candidate.length === rest.length) return true;
  const lastWord = candidate.slice(candidate.search(/\S+$/));
  return lastWord.includes(".");
}

/** The candidate itself, or its punctuation-stripped variant, if accepted. */
function resolveCandidate(
  candidate: string,
  isPath: (candidate: string) => boolean,
): string | null {
  if (isPath(candidate)) return candidate;
  const stripped = candidate.replace(TRAILING_PUNCTUATION, "");
  if (stripped && stripped !== candidate && isPath(stripped)) return stripped;
  return null;
}

/** Longest accepted candidate, with the length the match consumed. */
function longestMention(
  rest: string,
  isPath: (candidate: string) => boolean,
): { hit: string; consumed: number } | null {
  const candidates = mentionCandidates(rest);
  for (let i = candidates.length - 1; i >= 0; i--) {
    if (!isPlausibleMention(candidates[i], rest)) continue;
    const hit = resolveCandidate(candidates[i], isPath);
    if (hit) return { hit, consumed: candidates[i].length };
  }
  return null;
}

export type MentionSegment =
  { type: "text"; value: string } | { type: "mention"; value: string };

/**
 * Split a prompt into plain-text runs and resolved mentions, in order. For
 * each "@" (at start of text or after whitespace) the candidates are the
 * line's word-boundary prefixes, tested longest first, with a
 * trailing-punctuation-stripped variant of each ("see @notes.md." still
 * resolves). Tokens nothing accepts are just text. Used to rebuild chips
 * from a persisted plain-string draft, and via extractMentionPaths at
 * submit time.
 */
export function segmentMentions(
  text: string,
  isPath: (candidate: string) => boolean,
): MentionSegment[] {
  const segments: MentionSegment[] = [];
  let plainFrom = 0;
  const pushText = (to: number) => {
    if (to > plainFrom) {
      segments.push({ type: "text", value: text.slice(plainFrom, to) });
    }
  };

  const mentionStart = /(?:^|\s)@/g;
  let match: RegExpExecArray | null;
  while ((match = mentionStart.exec(text))) {
    const start = match.index + match[0].length;
    const newline = text.indexOf("\n", start);
    const rest = text.slice(start, newline === -1 ? text.length : newline);
    if (!rest || /^\s/.test(rest)) continue;

    const mention = longestMention(rest, isPath);
    if (!mention) continue;
    pushText(start - 1);
    segments.push({ type: "mention", value: mention.hit });
    // Trailing punctuation the resolution stripped stays in the next text
    // segment; the scan resumes after the matched mention, not the "@".
    plainFrom = start + mention.hit.length;
    mentionStart.lastIndex = start + mention.consumed;
  }
  pushText(text.length);
  return segments;
}

/** Every distinct resolved mention in a finished prompt, in order. */
export function extractMentionPaths(
  text: string,
  isPath: (candidate: string) => boolean,
): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const segment of segmentMentions(text, isPath)) {
    if (segment.type !== "mention" || seen.has(segment.value)) continue;
    seen.add(segment.value);
    found.push(segment.value);
  }
  return found;
}

// ─── The suggestion popup ───────────────────────────────────────────────

const SUGGESTION_LIMIT = 8;

/** Rebuild a persisted plain-string draft as a doc with mention chips for
 *  every token that resolves to a workspace file. */
function draftToDoc(
  isPath: (token: string) => boolean,
  draft: string,
): JSONContent {
  const paragraph: JSONContent[] = [];
  for (const line of draft.split("\n")) {
    if (paragraph.length > 0) paragraph.push({ type: "hardBreak" });
    for (const segment of segmentMentions(line, isPath)) {
      if (segment.type === "text") {
        if (segment.value)
          paragraph.push({ type: "text", text: segment.value });
      } else {
        paragraph.push({
          type: "mention",
          attrs: {
            id: segment.value,
            label: segment.value.slice(segment.value.lastIndexOf("/") + 1),
          },
        });
      }
    }
  }
  return {
    type: "doc",
    content: [
      { type: "paragraph", content: paragraph.length ? paragraph : undefined },
    ],
  };
}

/** Chips serialize back to the literal `@<relativePath>` the submit paths
 *  re-parse; hard breaks back to newlines. */
function serializeDoc(editor: Editor): string {
  return editor.getText({
    blockSeparator: "\n",
    textSerializers: {
      hardBreak: () => "\n",
      mention: ({ node }) => `@${node.attrs.id}`,
    },
  });
}

type SuggestionRenderer = () => {
  onStart: (props: SuggestionProps<MentionCandidate>) => void;
  onUpdate: (props: SuggestionProps<MentionCandidate>) => void;
  onKeyDown: (props: SuggestionKeyDownProps) => boolean;
  onExit: () => void;
};

/** The full extension set: plain-text core (paragraph/hardBreak/undo only),
 *  placeholder, and the "@" file-mention trigger. More cues later = more
 *  entries in `suggestions`. */
function promptExtensions(
  host: PromptWidgetHost,
  workspacePath: string,
  placeholder: string,
  renderer: SuggestionRenderer,
) {
  return [
    StarterKit.configure({
      blockquote: false,
      bold: false,
      bulletList: false,
      code: false,
      codeBlock: false,
      dropcursor: false,
      gapcursor: false,
      heading: false,
      horizontalRule: false,
      italic: false,
      link: false,
      listItem: false,
      listKeymap: false,
      orderedList: false,
      strike: false,
      trailingNode: false,
      underline: false,
    }),
    // showOnlyWhenEditable: false — the chat composer disables the editor
    // during session load, and the loading placeholder is the only signal.
    Placeholder.configure({ placeholder, showOnlyWhenEditable: false }),
    Mention.configure({
      deleteTriggerWithBackspace: true,
      // Muted chip background so mentions read as attachments — rendering
      // only; the serialized draft stays the literal @path text.
      HTMLAttributes: {
        class: "rounded-sm bg-muted px-1 whitespace-nowrap",
      },
      renderHTML: ({ options, node }) => [
        "span",
        mergeAttributes(options.HTMLAttributes, {
          "data-type": "mention",
          "data-id": node.attrs.id,
        }),
        `@${node.attrs.label ?? node.attrs.id}`,
      ],
      suggestion: {
        char: "@",
        items: ({ query }) =>
          host.searchWorkspaceFiles(workspacePath, query, SUGGESTION_LIMIT),
        // Pinned directly under the "@" (the anchor is the suggestion
        // decoration, whose left edge is the trigger char). Fixed strategy
        // sidesteps offset-parent math inside the dock/editor stack.
        placement: "bottom-start",
        offset: { mainAxis: 2, crossAxis: 0 },
        floatingUi: { strategy: "fixed" },
        render: renderer,
      },
    }),
  ];
}

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

function SuggestionList({
  items,
  selectedIndex,
  onPick,
  onHover,
}: {
  items: MentionCandidate[];
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
          key={item.path}
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
          <FileIcon
            path={item.path}
            className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
          />
          {/* One combined label: the name stays whole, the dir summary
              truncates first. */}
          <span className="flex min-w-0 items-baseline" dir="ltr">
            <span className="min-w-0 truncate text-muted-foreground">
              {summarizeDirPrefix(item)}
            </span>
            <span className="shrink-0">{item.title}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

/** The suggestion popup's state machine, out of the component so the
 *  plugin-facing callbacks (which close over the first render — live values
 *  ride in refs) stay separate from the editor wiring. */
function useMentionSuggestion() {
  const [popup, setPopup] = useState<SuggestionPopupState | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const popupRef = useRef(popup);
  popupRef.current = popup;
  const selectedIndexRef = useRef(selectedIndex);
  selectedIndexRef.current = selectedIndex;
  const unmountPopup = useRef<(() => void) | null>(null);

  const applySuggestion = useCallback(
    (props: SuggestionProps<MentionCandidate>) => {
      setPopup((previous) => {
        if (!previous) return previous;
        return {
          ...previous,
          items: props.items,
          command: (attrs) => props.command(attrs as never),
        };
      });
      setSelectedIndex(0);
    },
    [],
  );

  const pick = useCallback((state: SuggestionPopupState, index: number) => {
    const item = state.items[index];
    if (!item) return;
    state.command({ id: item.relativePath, label: item.title });
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
        setPopup({
          container,
          items: props.items,
          command: (attrs) => props.command(attrs as never),
        });
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
 * Prop → editor synchronization. useEditor can hand out an instance that
 * has since been destroyed (the dock unmounts tabs, and StrictMode
 * double-mounts): Editor.destroy() nulls commandManager while the
 * `commands` getter has no guard, so every imperative entry point checks
 * isDestroyed first (crash report 2026-08-21, focus on a stale chat-tab
 * handle) — re-checked inside each effect too, since a StrictMode cleanup
 * can destroy the instance between render and effect.
 */
function usePromptEditorSync({
  editor,
  value,
  isPath,
  disabled,
  lastEmitted,
}: {
  editor: Editor | null;
  value: string;
  isPath: (token: string) => boolean;
  disabled: boolean;
  lastEmitted: React.MutableRefObject<string>;
}) {
  const liveEditor = editor && !editor.isDestroyed ? editor : null;

  // Controlled-value round trip: only re-set content when the change came
  // from outside (draft cleared after send, Escape-restore) — re-setting on
  // every keystroke would drop chips mid-composition and reset the caret.
  useEffect(() => {
    if (!liveEditor || liveEditor.isDestroyed) return;
    if (value === lastEmitted.current) return;
    lastEmitted.current = value;
    liveEditor.commands.setContent(draftToDoc(isPath, value), {
      emitUpdate: false,
    });
    // Put the caret back at the end of the swapped-in draft, but only when
    // this composer already holds focus: pulling focus in from somewhere
    // else is the focus arbiter's decision, not a side effect of a content
    // round trip (a send clearing the draft used to yank it back).
    if (liveEditor.isFocused) liveEditor.commands.focus("end");
  }, [liveEditor, value, isPath, lastEmitted]);

  useEffect(() => {
    if (!liveEditor || liveEditor.isDestroyed) return;
    liveEditor.setEditable(!disabled);
  }, [liveEditor, disabled]);

  // Reachable from the DOM for integration tests and devtools — simulated
  // typing has to go through real editor transactions (contenteditable
  // ignores synthetic input events).
  useEffect(() => {
    if (!liveEditor || liveEditor.isDestroyed) return;
    (
      liveEditor.view.dom as HTMLElement & { promptEditor?: Editor }
    ).promptEditor = liveEditor as Editor;
  }, [liveEditor]);
}

export const PromptEditor = forwardRef<
  PromptEditorHandle,
  {
    workspacePath: string;
    value: string;
    onChange: (value: string) => void;
    /** Host key map (deriveComposerKeyAction etc.). Runs first — except
     *  while the suggestion popup is open, which owns the keys it needs.
     *  Return true to consume. */
    onKeyDown?: (event: KeyboardEvent) => boolean;
    placeholder: string;
    disabled?: boolean;
    autoFocus?: boolean;
    className?: string;
  }
>(function PromptEditor(
  {
    workspacePath,
    value,
    onChange,
    onKeyDown,
    placeholder,
    disabled = false,
    autoFocus = false,
    className,
  },
  ref,
) {
  const host = usePromptWidgetHost();
  // Stable across renders for the same workspace: it feeds an effect
  // dependency, and a fresh closure each render would re-set the content.
  const isPath = useCallback(
    (token: string) => host.isWorkspaceFile(workspacePath, token),
    [host, workspacePath],
  );
  const onKeyDownRef = useRef(onKeyDown);
  onKeyDownRef.current = onKeyDown;
  const lastEmitted = useRef(value);
  const { popup, popupRef, selectedIndex, setSelectedIndex, pick, renderer } =
    useMentionSuggestion();

  const editor = useEditor(
    {
      extensions: promptExtensions(host, workspacePath, placeholder, renderer),
      content: draftToDoc(isPath, value),
      editable: !disabled,
      autofocus: autoFocus ? "end" : false,
      editorProps: {
        attributes: {
          class: "focus:outline-none",
          role: "textbox",
          "aria-multiline": "true",
        },
        handleKeyDown: (_view, event) => {
          // While the popup is open WITH results, the suggestion plugin
          // (which runs after view props) owns Arrows/Enter/Tab/Escape. An
          // active suggestion with no matches must not eat the host's keys.
          if (popupRef.current && popupRef.current.items.length > 0) {
            return false;
          }
          return onKeyDownRef.current?.(event) ?? false;
        },
      },
      onUpdate: ({ editor: instance }) => {
        const text = serializeDoc(instance as Editor);
        lastEmitted.current = text;
        onChange(text);
      },
    },
    // Recreating on placeholder change is fine: it only flips alongside
    // `disabled` (session load), and content re-seeds from the draft prop.
    [workspacePath, placeholder],
  );

  usePromptEditorSync({ editor, value, isPath, disabled, lastEmitted });

  useImperativeHandle(
    ref,
    () => ({
      focus: () => {
        if (!editor || editor.isDestroyed || !editor.isEditable) return false;
        editor.commands.focus("end");
        return true;
      },
    }),
    [editor],
  );

  return (
    <>
      <EditorContent
        editor={editor}
        className={cn(
          "prompt-editor min-w-0 [&_.ProseMirror]:outline-none [&_.ProseMirror]:whitespace-pre-wrap [&_.ProseMirror]:break-words",
          disabled && "pointer-events-none opacity-60",
          className,
        )}
      />
      {popup &&
        popup.items.length > 0 &&
        createPortal(
          <SuggestionList
            items={popup.items}
            selectedIndex={selectedIndex}
            onPick={(index) => pick(popup, index)}
            onHover={setSelectedIndex}
          />,
          popup.container,
        )}
    </>
  );
});
