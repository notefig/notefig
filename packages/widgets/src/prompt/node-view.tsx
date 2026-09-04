/**
 * Renderer half of the aiPrompt widget (schema base + markdown serializer
 * live in node.ts; pure doc helpers in doc-helpers.ts): the React node view
 * hosting the PromptBlob chrome, the empty-document keeper, and the "/"
 * summon.
 *
 * The draft the user types is document content — the widget's `promptDraft`
 * child, rendered through NodeViewContent. That is what puts the composer
 * inside the editor's own lifecycle: the caret in a prompt is an ordinary
 * ProseMirror selection, so the tab layout's selection memory, the viewport
 * memory and the focus arbiter all reach it without knowing widgets exist.
 *
 * Keeper — the "active by default on new documents" rule: an editor whose
 * document has no real content always carries exactly one aiPrompt node at
 * its start, and it comes back if deleted while the doc is still empty.
 * Keeper transactions are UI-only: they don't join the undo history (a ⌘Z
 * fight with reinsertion) and they carry UI_ONLY_TRANSACTION_META so the
 * autosave path ignores them.
 *
 * Summon — typing "/" in an empty paragraph (top-level, or nested purely in
 * bullet/ordered lists) replaces it with a widget and puts the caret in its
 * draft; Esc or a second "/" while the draft is empty reverts it to a
 * literal "/". In an empty doc the keeper widget already exists, so "/" just
 * moves the caret there. Docs with content are never force-populated, and
 * deleting the widget there is final.
 */
import { ReactNodeViewRenderer, NodeViewWrapper, NodeViewContent } from "@tiptap/react";
import type { NodeViewProps } from "@tiptap/react";
import { Plugin } from "@tiptap/pm/state";
import { Selection, TextSelection } from "@tiptap/pm/state";
import Suggestion from "@tiptap/suggestion";
import { useEffect, useRef } from "react";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { AiPromptNodeBase, PROMPT_NODE_NAME } from "./node";
import { UI_ONLY_TRANSACTION_META } from "../define-widget";
import {
  docHasPromptNode,
  docHasRealContent,
  findPromptNodeId,
  newPromptBlobInstanceId,
  promptDraftRange,
  removeToParagraphTr,
  revertToSlashTr,
  selectionDraft,
  slashSummonTr,
  trailingParagraphTr,
} from "./doc-helpers";
import { PromptBlob } from "./ui/prompt-blob";
import { adoptPersistedPromptBinding } from "./store";
import {
  getMentionService,
  mentionPopupHasResults,
} from "./composer/mention-bridge";
import { dispatchComposerKey } from "./composer/key-bridge";
import { PROMPT_MENTION_NAME } from "./composer/mention-node";
import { readDraftNode } from "./composer/draft-text";
import { usePromptWidgetHost } from "./host-context";

export interface AiPromptNodeOptions {
  /** Absolute path of the host document (empty in schema-only contexts). */
  filePath: string;
  /** Workspace root the prompt's session is scoped to. */
  basePath: string;
}


/**
 * Move the caret across a widget boundary for ArrowUp (dir -1) / ArrowDown
 * (dir 1): out of a draft into the neighbouring textblock, or from a
 * neighbouring block into the draft. Returns false whenever the caret is not
 * at the textblock's edge in that direction, so ordinary line movement stays
 * native.
 */
function arrowAcrossWidget(editor: NodeViewProps["editor"], dir: -1 | 1): boolean {
  const { state, view } = editor;
  const { selection } = state;
  if (!(selection instanceof TextSelection) || !selection.empty) return false;
  if (!view.endOfTextblock(dir < 0 ? "up" : "down")) return false;
  const target = selectionDraft(state)
    ? draftExitTarget(state, dir)
    : draftEntryTarget(state, dir);
  if (!target) return false;
  view.dispatch(state.tr.setSelection(target).scrollIntoView());
  return true;
}

/**
 * Newline inside a draft. HardBreak's own default keymap (Shift-Enter /
 * Mod-Enter) calls its `setHardBreak` command, which bails out whenever the
 * selection's immediate parent is an isolating node
 * (`selection.$from.parent.type.spec.isolating`) — exactly what the draft is
 * (node.ts), by design, to fence Backspace/joins/drags from crossing its
 * edge. That guard silently swallows the built-in shortcut inside a draft,
 * so it needs its own insertion that doesn't route through that command.
 */
function insertDraftHardBreak(editor: NodeViewProps["editor"]): boolean {
  const { state, view } = editor;
  if (!selectionDraft(state)) return false;
  const hardBreak = state.schema.nodes.hardBreak;
  if (!hardBreak) return false;
  view.dispatch(state.tr.replaceSelectionWith(hardBreak.create()).scrollIntoView());
  return true;
}

/** Leaving the draft: the selection in the block next to the widget, or
 *  null at the doc's edge — the gap cursor plugin offers its position
 *  there instead. */
function draftExitTarget(state: EditorState, dir: -1 | 1): Selection | null {
  const { $from } = state.selection;
  let widgetDepth = -1;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === PROMPT_NODE_NAME) {
      widgetDepth = d;
      break;
    }
  }
  if (widgetDepth < 0) return null;
  const edge = dir < 0 ? $from.before(widgetDepth) : $from.after(widgetDepth);
  const target = Selection.near(state.doc.resolve(edge), dir);
  const escaped =
    target.$from.pos !== $from.pos && !selectionDraft({ selection: target });
  return escaped ? target : null;
}

/** Entering a draft: only when the top-level sibling in that direction is a
 *  widget (nested contexts keep native movement). */
function draftEntryTarget(state: EditorState, dir: -1 | 1): Selection | null {
  const { $from } = state.selection;
  const $edge = state.doc.resolve(dir < 0 ? $from.before(1) : $from.after(1));
  const neighbour = dir < 0 ? $edge.nodeBefore : $edge.nodeAfter;
  if (neighbour?.type.name !== PROMPT_NODE_NAME) return null;
  const target = Selection.near($edge, dir);
  return selectionDraft({ selection: target }) ? target : null;
}

/** The keeper's insertion, or null when the doc doesn't need one. */
function appendPromptTr(
  state: EditorState,
): { tr: Transaction; blobId: string } | null {
  if (docHasRealContent(state.doc) || docHasPromptNode(state.doc)) return null;
  const type = state.schema.nodes[PROMPT_NODE_NAME];
  if (!type) return null;
  const blobId = newPromptBlobInstanceId();
  // Top of the body: above the empty paragraph, so a fresh doc shows no
  // blank line before it (the paragraph below stays as the caret landing
  // spot for Escape/click-into-editor) — but after a leading frontmatter
  // node, whose doc position the content expression pins to 0 (MET-137).
  const first = state.doc.firstChild;
  const insertPos =
    first && first.type.name === "frontmatter" ? first.nodeSize : 0;
  // createAndFill, not create: the content expression requires a draft
  // child, and a widget without one has nowhere to put a caret.
  const node = type.createAndFill({ blobId });
  if (!node) return null;
  const tr = state.tr
    .insert(insertPos, node)
    .setMeta("addToHistory", false)
    .setMeta(UI_ONLY_TRANSACTION_META, true);
  return { tr, blobId };
}

/**
 * Put the caret in a widget's draft. This replaces the one-shot focus
 * channel the atom era needed: the draft is document content, so "focus the
 * composer" is a selection, dispatched in the same transaction that created
 * the widget — no React-pass gap to bridge, and nothing for the focus
 * arbiter to arbitrate.
 */
function selectDraftTr(tr: Transaction, blobId: string): Transaction {
  const range = promptDraftRange(tr.doc, blobId);
  if (!range) return tr;
  return tr.setSelection(TextSelection.create(tr.doc, range.to));
}

function AiPromptNodeView(props: NodeViewProps) {
  const { filePath, basePath } = props.extension.options as AiPromptNodeOptions;
  const host = usePromptWidgetHost();
  const blobId = (props.node.attrs.blobId as string | null) ?? null;
  const persistedTaskId = (props.node.attrs.taskId as string | null) ?? null;

  // Repair id-less instances (schema defaults survive clipboard round-trips
  // — renderHTML doesn't carry attrs). One UI-only-ish attr write; the node
  // view re-renders with the id and mounts the widget then.
  const needsId = Boolean(filePath) && blobId === null;
  useEffect(() => {
    if (needsId) {
      props.updateAttributes({ blobId: newPromptBlobInstanceId() });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsId]);

  // A widget restored from the file (MET-163) carries its session in the
  // node; adopting it is what makes the widget prompt that session instead
  // of opening a new one. A session that is gone for good is discarded
  // silently — the widget simply stays unbound and behaves as a fresh
  // composer, and the next prompt rebinds it, rewriting the marker.
  //
  // Nothing here touches the document. An unreachable answer is not
  // trustworthy enough to edit the user's file on: the local task database
  // is recreated from scratch on corruption AND on any schemaVersion bump
  // (adapters/tauri-db.ts), and a wiped database is indistinguishable from
  // "these sessions never existed". Acting on that by deleting nodes would
  // strip every widget from every open document as a side effect of an
  // infrastructure event. Leaving the id in the file costs nothing.
  //
  // The host is read through a ref and deliberately NOT a dependency: this
  // effect queries the task database, so re-running it is expensive, and its
  // real inputs are the three ids below. A host whose identity changed per
  // render once turned this into an unbounded read loop (each read updated a
  // collection, which re-rendered the provider, which re-ran the effect). The
  // host is stable again, but nothing about correctness here depends on that
  // — so it shouldn't depend on it.
  const hostRef = useRef(host);
  hostRef.current = host;
  useEffect(() => {
    if (!filePath || !blobId || !persistedTaskId) return;
    let cancelled = false;
    void hostRef.current.isTaskReachable(persistedTaskId).then((reachable) => {
      if (cancelled || !reachable) return;
      adoptPersistedPromptBinding(blobId, persistedTaskId);
    });
    return () => {
      cancelled = true;
    };
  }, [filePath, blobId, persistedTaskId]);

  // The content hole must exist even before the widget is addressable
  // (id-less clipboard instances, schema-only contexts): ProseMirror
  // requires a node's contentDOM to stay mounted at all times, and an
  // unmounted one detaches the draft from the document.
  if (!filePath || !basePath || blobId === null) {
    return (
      <NodeViewWrapper data-type="ai-prompt" className="not-prose my-1">
        <NodeViewContent />
      </NodeViewWrapper>
    );
  }

  const removeNode = (options?: {
    insertSlash?: boolean;
    restoreParagraph?: boolean;
  }) => {
    if (options?.restoreParagraph) {
      const pos = props.getPos();
      if (typeof pos !== "number") return;
      const { view } = props.editor;
      view.dispatch(removeToParagraphTr(view.state, pos, props.node.nodeSize));
      props.editor.commands.focus(undefined, { scrollIntoView: false });
      return;
    }
    if (!options?.insertSlash) {
      props.deleteNode();
      return;
    }
    const pos = props.getPos();
    if (typeof pos !== "number") return;
    const { view } = props.editor;
    view.dispatch(revertToSlashTr(view.state, pos, props.node.nodeSize));
    props.editor.commands.focus(undefined, { scrollIntoView: false });
  };

  return (
    // not-prose: the widget is chrome, not typography — keep the prose
    // styles of the surrounding document off it. The wrapper is NOT
    // contentEditable={false} any more: the draft inside it is real
    // document text, and each chrome subtree opts out for itself.
    <NodeViewWrapper
      data-type="ai-prompt"
      data-blob-id={blobId}
      className="not-prose my-1"
    >
      <PromptBlob
        blobId={blobId}
        workspacePath={basePath}
        documentPath={filePath}
        editor={props.editor}
        getPos={props.getPos}
        summoned={Boolean(props.node.attrs.summoned)}
        removeNode={removeNode}
        onSessionBound={(taskId) => props.updateAttributes({ taskId })}
        draft={props.node.firstChild ? readDraftNode(props.node.firstChild) : ""}
        draftSlot={<NodeViewContent />}
      />
    </NodeViewWrapper>
  );
}

/**
 * The widget's renderer half. Deliberately host-free: the ProseMirror plugins
 * below (the keeper, the "/" summon, the mention suggestion) need nothing
 * from the application, and the node view is a React component — it reads the
 * host from context, the same way it already read the app's tab provider
 * before the extraction. The suggestion's two application-facing needs (the
 * workspace file search, and somewhere to render its popup) arrive through
 * mention-bridge.ts, whose service the document's mounted menu registers.
 */
export const AiPromptNode = AiPromptNodeBase.extend<AiPromptNodeOptions>({
  addOptions() {
    return { filePath: "", basePath: "" };
  },

  addNodeView() {
    return ReactNodeViewRenderer(AiPromptNodeView);
  },

  onCreate() {
    // Documents open empty (new files) get the widget from the start, with
    // the caret already in its draft.
    if (!this.options.filePath) return;
    const caret = trailingParagraphTr(this.editor.state);
    if (caret) {
      this.editor.view.dispatch(
        caret
          .setMeta("addToHistory", false)
          .setMeta(UI_ONLY_TRANSACTION_META, true),
      );
    }
    const res = appendPromptTr(this.editor.state);
    if (!res) return;
    this.editor.view.dispatch(selectDraftTr(res.tr, res.blobId));
  },

  /**
   * The composer's keys, delivered where ProseMirror actually routes them.
   *
   * Key events in a contenteditable target the editing host — the document's
   * `.ProseMirror` root — never the element under the caret, so a DOM
   * listener on the widget's own card cannot see them (the root is its
   * ancestor; bubbling goes the other way). An extension keymap is the
   * Tiptap-native path: it runs for a caret inside the draft, defers to the
   * mention popup (the React handler checks it) and to every other binding
   * by returning false.
   *
   * The actions live in the mounted PromptBlob (they need the store and the
   * host), reached through key-bridge.ts exactly like the mention popup is
   * reached through mention-bridge.ts.
   */
  addKeyboardShortcuts() {
    const forward = (key: string, shiftKey = false) => () => {
      const draft = selectionDraft(this.editor.state);
      if (!draft) return false;
      return dispatchComposerKey(draft.blobId, { key, shiftKey });
    };
    const suggestionOwnsArrows = () =>
      Boolean(selectionDraft(this.editor.state)) &&
      mentionPopupHasResults(this.options.filePath);
    return {
      Enter: forward("Enter"),
      // Multi-line input: StarterKit's HardBreak binds these two combos
      // itself, but its command bails inside the draft's isolating node (see
      // insertDraftHardBreak) — so the draft handles them directly instead
      // of falling through to that dead default.
      "Shift-Enter": () => insertDraftHardBreak(this.editor),
      "Mod-Enter": () => insertDraftHardBreak(this.editor),
      Escape: forward("Escape"),
      // Plain Backspace, clamped like its Mod/Alt variants below: the
      // composer map gets its dismiss chance first (empty draft), then
      // the character/selection delete happens as a
      // ProseMirror transaction and the key is consumed. Left unhandled,
      // the browser edits the draft's DOM natively — and WebKit deleting
      // the draft's LAST character can mangle the editable island badly
      // enough that the re-parse drops the whole widget: the same failure
      // the Mod-Backspace comment describes, reachable from a plain
      // keypress. A mention chip stays with the Mention extension's own
      // Backspace (deleteTriggerWithBackspace turns it back into text).
      // The composer map first (an empty draft DISMISSES, dispatching its
      // own transaction — which is why it must run outside
      // commands.command: the command's tr is captured before the callback
      // runs, and dispatching that stale tr afterwards reverts the
      // removal).
      Backspace: () => {
        if (forward("Backspace")()) return true;
        return this.editor.commands.command(({ state, tr }) => {
          const draft = selectionDraft(state);
          if (!draft) return false;
          const { selection } = state;
          if (!selection.empty) {
            tr.delete(selection.from, Math.min(selection.to, draft.to));
            return true;
          }
          const caret = selection.from;
          // Draft start: nothing to delete, but still consumed — an
          // unhandled press here reaches the browser's cross-boundary
          // native delete.
          if (caret <= draft.from) return true;
          if (selection.$from.nodeBefore?.type.name === PROMPT_MENTION_NAME) {
            return false;
          }
          tr.delete(caret - 1, caret);
          return true;
        });
      },
      // The "//" revert: a second "/" in an empty summoned draft turns the
      // widget back into a literal slash. Not consumed (draft has text, or
      // an unsummoned widget): falls through and types normally.
      "/": forward("/"),
      // Vertical traversal across the widget boundary, made explicit.
      // WebKit's native caret movement can cross from an adjacent paragraph
      // into the draft (an editable island fenced by contentEditable=false
      // chrome), but Chromium's cannot — the caret just sticks. Handling
      // both directions here makes the crossing deterministic on every
      // engine: one press in, one press out. The doc-start/doc-end cases
      // fall through (return false) so the gap cursor can still offer a
      // place above/below a widget at the document's edge.
      //
      // An open mention popup owns vertical navigation — the same deferral
      // Enter/Escape get through the composer handler: while the popup has
      // rows, returning false hands the arrows to the suggestion plugin's
      // own onKeyDown (it runs after this keymap) so they step through the
      // list instead of carrying the caret out of the widget.
      ArrowUp: () =>
        !suggestionOwnsArrows() && arrowAcrossWidget(this.editor, -1),
      ArrowDown: () =>
        !suggestionOwnsArrows() && arrowAcrossWidget(this.editor, 1),
      // Delete-to-line-start. Inside a draft the composer map gets its
      // dismiss chance first (empty summoned draft), then the delete is
      // clamped to the draft's own start — and the key is ALWAYS consumed
      // there: no binding handles it (Tiptap's chain fails mid-text), so it
      // would otherwise fall through to the browser's native
      // deleteSoftLineBackward, whose "line" ignores node boundaries and
      // mangles the widget's DOM badly enough that the re-parse drops the
      // whole node.
      "Mod-Backspace": () => {
        if (forward("Backspace")()) return true;
        return this.editor.commands.command(({ state, tr }) => {
          const draft = selectionDraft(state);
          if (!draft) return false;
          const { selection } = state;
          // Caret: delete back to the draft's start. Range: delete it.
          const from = selection.empty ? draft.from : selection.from;
          if (selection.to > from) tr.delete(from, selection.to);
          return true;
        });
      },
      // Word-delete, clamped the same way (native deleteWordBackward crosses
      // the boundary just like the soft-line variant). Empty summoned draft:
      // same dismiss as plain Backspace.
      "Alt-Backspace": () => {
        if (forward("Backspace")()) return true;
        return this.editor.commands.command(({ state, tr }) => {
          const draft = selectionDraft(state);
          if (!draft) return false;
          const { selection } = state;
          if (!selection.empty) {
            tr.delete(selection.from, selection.to);
            return true;
          }
          const caret = selection.from;
          if (caret <= draft.from) return true;
          // 1:1 position math: draft content is flat (text | mention |
          // hardBreak), and every leaf serializes to one placeholder char.
          const text = state.doc.textBetween(draft.from, caret, "\ufffc", "\ufffc");
          const kept = text.replace(/\s+$/u, "").replace(/\S+$/u, "");
          tr.delete(draft.from + kept.length, caret);
          return true;
        });
      },
      // macOS kill-line. Unclamped it deletes the paragraph AFTER the
      // widget from inside the draft; here it kills to the next hardBreak
      // (or eats one it is sitting on), never past the draft's end.
      "Ctrl-k": () => {
        return this.editor.commands.command(({ state, tr }) => {
          const draft = selectionDraft(state);
          if (!draft) return false;
          const { selection } = state;
          if (!selection.empty) {
            tr.delete(selection.from, selection.to);
            return true;
          }
          const caret = selection.from;
          if (caret >= draft.to) return true;
          const text = state.doc.textBetween(caret, draft.to, "\ufffc", (node) =>
            node.type.name === "hardBreak" ? "\n" : "\ufffc",
          );
          const brk = text.indexOf("\n");
          const end = brk === -1 ? draft.to : brk === 0 ? caret + 1 : caret + brk;
          if (end > caret) tr.delete(caret, end);
          return true;
        });
      },
    };
  },

  addProseMirrorPlugins() {
    const { options } = this;
    return [
      new Plugin({
        props: {
          // The "/" summon. Returning true consumes the keystroke.
          handleTextInput(view, _from, _to, text) {
            if (!options.filePath || text !== "/") return false;
            // Already in a draft: "/" is ordinary text there. (The revert
            // contract — a second "/" in an empty summoned draft — is the
            // composer key map's, in the widget's own chrome.)
            if (selectionDraft(view.state)) return false;
            // Empty doc: the keeper widget is already there — "/" means
            // "give me the prompt", so move the caret into it instead of
            // inserting a second one (or a stray slash).
            if (
              !docHasRealContent(view.state.doc) &&
              docHasPromptNode(view.state.doc)
            ) {
              const existingId = findPromptNodeId(view.state.doc);
              if (existingId) {
                view.dispatch(selectDraftTr(view.state.tr, existingId));
              }
              return true;
            }
            const blobId = newPromptBlobInstanceId();
            const tr = slashSummonTr(view.state, blobId);
            if (!tr) return false;
            view.dispatch(selectDraftTr(tr, blobId));
            return true;
          },
        },
        appendTransaction(transactions, _oldState, newState) {
          if (!options.filePath) return null;
          if (!transactions.some((tr) => tr.docChanged)) return null;
          // Became-empty reinsert: no caret move — the user's cursor is in
          // the editor and must stay there.
          const keeper = appendPromptTr(newState)?.tr;
          if (keeper) return keeper;
          // A widget left as the document's last block (adopting a file that
          // holds only a persisted marker) needs a caret landing spot.
          const caret = trailingParagraphTr(newState);
          return caret
            ? caret
                .setMeta("addToHistory", false)
                .setMeta(UI_ONLY_TRANSACTION_META, true)
            : null;
        },
      }),
      // The "@" file mention, scoped to drafts. Registered here rather than
      // as a standalone extension so the scoping travels with the widget
      // that owns it: `allow` is the whole of it — outside a draft the
      // trigger never starts, so "@" stays ordinary prose everywhere else.
      Suggestion({
        editor: this.editor,
        char: "@",
        allow: ({ state, range }) =>
          Boolean(
            selectionDraft({
              selection: { $from: state.doc.resolve(range.from) },
            }),
          ),
        items: ({ query }) =>
          getMentionService(options.filePath)?.search(query) ?? [],
        // Pinned directly under the "@" (the anchor is the suggestion
        // decoration, whose left edge is the trigger char). Fixed strategy
        // sidesteps offset-parent math inside the dock/editor stack.
        placement: "bottom-start",
        offset: { mainAxis: 2, crossAxis: 0 },
        floatingUi: { strategy: "fixed" },
        command: ({ editor, range, props }) => {
          editor
            .chain()
            .focus()
            .insertContentAt(range, [
              { type: "mention", attrs: props },
              { type: "text", text: " " },
            ])
            .run();
        },
        render: () => ({
          onStart: (props) =>
            getMentionService(options.filePath)?.onStart(props),
          onUpdate: (props) =>
            getMentionService(options.filePath)?.onUpdate(props),
          onKeyDown: (props) =>
            getMentionService(options.filePath)?.onKeyDown(props) ?? false,
          onExit: () => getMentionService(options.filePath)?.onExit(),
        }),
      }),
    ];
  },
});
