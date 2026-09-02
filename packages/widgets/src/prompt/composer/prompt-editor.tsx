import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@notefig/ui/utils";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { usePromptWidgetHost } from "../host-context";
import type { PromptWidgetHost } from "../host";
import { promptMentionNode } from "./mention-node";
import {
  DRAFT_TEXT_SERIALIZERS,
  draftToDoc,
} from "./draft-text";
import {
  SuggestionList,
  SUGGESTION_LIMIT,
  useMentionSuggestion,
  type SuggestionRenderer,
} from "./mention-menu";

/** Re-exported from their own modules: this file is the standalone composer,
 *  and the mention contract is shared with the widget's in-document draft. */
export {
  extractMentionPaths,
  segmentMentions,
  type MentionSegment,
} from "./draft-text";

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

/** The standalone composer's extension set: plain-text core
 *  (paragraph/hardBreak/undo only), placeholder, and the "@" file-mention
 *  trigger. A document's drafts get the mention node from the widget's own
 *  registration instead — see composer/mention-node.ts. */
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
    promptMentionNode({
      char: "@",
      items: ({ query }: { query: string }) =>
        host.searchWorkspaceFiles(workspacePath, query, SUGGESTION_LIMIT),
      // Pinned directly under the "@" (the anchor is the suggestion
      // decoration, whose left edge is the trigger char). Fixed strategy
      // sidesteps offset-parent math inside the dock/editor stack.
      placement: "bottom-start",
      offset: { mainAxis: 2, crossAxis: 0 },
      floatingUi: { strategy: "fixed" },
      render: renderer,
    }),
  ];
}

/** Chips serialize back to the literal `@<relativePath>` the submit paths
 *  re-parse; hard breaks back to newlines. */
function serializeDoc(editor: Editor): string {
  return editor.getText({
    blockSeparator: "\n",
    textSerializers: DRAFT_TEXT_SERIALIZERS,
  });
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
