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
import type { JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import Mention from "@tiptap/extension-mention";
import type {
  SuggestionKeyDownProps,
  SuggestionProps,
} from "@tiptap/suggestion";
import { getOrCreateWorkspaceCollections } from "@/entities/files";
import { canOpenFile } from "@/components/editor/polymorphic-editor";
import { FileTypeIcon } from "@/components/editor/file-type-icon";
import { rankFileRows, type FileSearchResult } from "@/utils/file-score";
import { segmentMentions } from "@/utils/prompt-mentions";
import { cn } from "@/lib/utils";

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
  focus: () => void;
}

interface SuggestionPopupState {
  container: HTMLElement;
  items: FileSearchResult[];
  command: (attrs: { id: string; label: string }) => void;
}

const SUGGESTION_LIMIT = 8;

function searchWorkspaceFiles(
  workspacePath: string,
  query: string,
): FileSearchResult[] {
  const { metadata } = getOrCreateWorkspaceCollections(workspacePath);
  return rankFileRows(metadata.toArray, query, {
    limit: SUGGESTION_LIMIT,
    filter: canOpenFile,
    matchAllWhenEmpty: true,
  });
}

/** Rebuild a persisted plain-string draft as a doc with mention chips for
 *  every token that resolves to a workspace file. */
function draftToDoc(workspacePath: string, draft: string): JSONContent {
  const { metadata } = getOrCreateWorkspaceCollections(workspacePath);
  const root = workspacePath.replace(/\/+$/, "");
  const isPath = (token: string) => {
    const row = metadata.get(`${root}/${token.replace(/^\/+/, "")}`);
    return row !== undefined && row.type === "file";
  };
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
  onStart: (props: SuggestionProps<FileSearchResult>) => void;
  onUpdate: (props: SuggestionProps<FileSearchResult>) => void;
  onKeyDown: (props: SuggestionKeyDownProps) => boolean;
  onExit: () => void;
};

/** The full extension set: plain-text core (paragraph/hardBreak/undo only),
 *  placeholder, and the "@" file-mention trigger. More cues later = more
 *  entries in `suggestions`. */
function promptExtensions(
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
    Placeholder.configure({ placeholder }),
    Mention.configure({
      deleteTriggerWithBackspace: true,
      HTMLAttributes: {
        class:
          "rounded bg-accent/70 px-1 py-0.5 text-accent-foreground whitespace-nowrap",
      },
      renderText: ({ node }) => `@${node.attrs.id}`,
      renderHTML: ({ node }) => [
        "span",
        { "data-type": "mention", "data-id": node.attrs.id },
        `@${node.attrs.label ?? node.attrs.id}`,
      ],
      suggestion: {
        char: "@",
        items: ({ query }) => searchWorkspaceFiles(workspacePath, query),
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

function SuggestionList({
  items,
  selectedIndex,
  onPick,
  onHover,
}: {
  items: FileSearchResult[];
  selectedIndex: number;
  onPick: (index: number) => void;
  onHover: (index: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      role="listbox"
      aria-label={t("mentionFilesLabel")}
      className="flex max-h-64 w-80 max-w-[90vw] flex-col overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md texture-surface"
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
            "flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-start text-sm",
            index === selectedIndex && "bg-accent text-accent-foreground",
          )}
        >
          <FileTypeIcon
            path={item.path}
            className="h-4 w-4 shrink-0 text-muted-foreground"
          />
          <span className="truncate">{item.title}</span>
          {item.relativePath !== item.title && (
            <span
              className="ms-auto min-w-0 truncate text-xs text-muted-foreground"
              dir="ltr"
            >
              {item.relativePath}
            </span>
          )}
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
    (props: SuggestionProps<FileSearchResult>) => {
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
  const onKeyDownRef = useRef(onKeyDown);
  onKeyDownRef.current = onKeyDown;
  const lastEmitted = useRef(value);
  const { popup, popupRef, selectedIndex, setSelectedIndex, pick, renderer } =
    useMentionSuggestion();

  const editor = useEditor(
    {
      extensions: promptExtensions(workspacePath, placeholder, renderer),
      content: draftToDoc(workspacePath, value),
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

  // Controlled-value round trip: only re-set content when the change came
  // from outside (draft cleared after send, Escape-restore) — re-setting on
  // every keystroke would drop chips mid-composition and reset the caret.
  useEffect(() => {
    if (!editor || value === lastEmitted.current) return;
    lastEmitted.current = value;
    editor.commands.setContent(draftToDoc(workspacePath, value), {
      emitUpdate: false,
    });
    editor.commands.focus("end");
  }, [editor, value, workspacePath]);

  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);

  // Reachable from the DOM for integration tests and devtools — simulated
  // typing has to go through real editor transactions (contenteditable
  // ignores synthetic input events).
  useEffect(() => {
    if (!editor) return;
    (editor.view.dom as HTMLElement & { promptEditor?: Editor }).promptEditor =
      editor as Editor;
  }, [editor]);

  useImperativeHandle(
    ref,
    () => ({ focus: () => editor?.commands.focus("end") }),
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
