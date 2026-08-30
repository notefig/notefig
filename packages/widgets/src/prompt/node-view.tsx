/**
 * Renderer half of the aiPrompt widget (schema base + markdown serializer
 * live in node.ts; pure doc helpers in doc-helpers.ts): the React node view
 * hosting the PromptBlob chrome, the empty-document keeper, and the "/"
 * summon.
 *
 * Keeper — the "active by default on new documents" rule: an editor whose
 * document has no real content always carries exactly one aiPrompt node at
 * its start, and it comes back if deleted while the doc is still empty.
 * Keeper transactions are UI-only: they don't join the undo history (a ⌘Z
 * fight with reinsertion) and they carry UI_ONLY_TRANSACTION_META so the
 * autosave path ignores them.
 *
 * Summon — typing "/" in an empty paragraph (top-level, or nested purely in
 * bullet/ordered lists) replaces it with a
 * focused widget (`summoned: true`); Esc or a second "/" while the composer
 * is empty reverts it to a literal "/". In an empty doc the keeper widget
 * already exists, so "/" just focuses it. Docs with content are never
 * force-populated, and deleting the widget there is final.
 */
import { ReactNodeViewRenderer, NodeViewWrapper } from "@tiptap/react";
import type { NodeViewProps } from "@tiptap/react";
import { Plugin } from "@tiptap/pm/state";
import { useEffect, useRef } from "react";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { AiPromptNodeBase, PROMPT_NODE_NAME } from "./node";
import { UI_ONLY_TRANSACTION_META } from "../define-widget";
import {
  docHasPromptNode,
  docHasRealContent,
  findPromptNodeId,
  newPromptBlobInstanceId,
  removeToParagraphTr,
  revertToSlashTr,
  slashSummonTr,
  trailingParagraphTr,
} from "./doc-helpers";
import { PromptBlob } from "./ui/prompt-blob";
import { adoptPersistedPromptBinding, requestPromptBlobFocus } from "./store";
import { usePromptWidgetHost } from "./host-context";

export interface AiPromptNodeOptions {
  /** Absolute path of the host document (empty in schema-only contexts). */
  filePath: string;
  /** Workspace root the prompt's session is scoped to. */
  basePath: string;
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
  const tr = state.tr
    .insert(insertPos, type.create({ blobId }))
    .setMeta("addToHistory", false)
    .setMeta(UI_ONLY_TRANSACTION_META, true);
  return { tr, blobId };
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

  if (!filePath || !basePath || blobId === null) return <NodeViewWrapper />;

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
    // styles of the surrounding document off it.
    <NodeViewWrapper
      data-type="ai-prompt"
      contentEditable={false}
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
      />
    </NodeViewWrapper>
  );
}

/**
 * The widget's renderer half. Deliberately host-free: the ProseMirror plugins
 * below (the keeper, the "/" summon) need nothing from the application, and
 * the node view is a React component — it reads the host from context, the
 * same way it already read the app's tab provider before the extraction. So
 * this stays a plain configurable extension, configured per document exactly
 * as it always was.
 */
export const AiPromptNode = AiPromptNodeBase.extend<AiPromptNodeOptions>({
  addOptions() {
    return { filePath: "", basePath: "" };
  },

  addNodeView() {
    return ReactNodeViewRenderer(AiPromptNodeView);
  },

  onCreate() {
    // Documents open empty (new files) get the widget from the start,
    // focused: the pending-focus channel survives the one-React-pass gap
    // before the node view mounts, and its consumer doesn't bail on the
    // editor already holding focus (unlike the mount auto-focus effect).
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
    this.editor.view.dispatch(res.tr);
    requestPromptBlobFocus(res.blobId);
  },

  addProseMirrorPlugins() {
    const { options } = this;
    return [
      new Plugin({
        props: {
          // The "/" summon. Returning true consumes the keystroke.
          handleTextInput(view, _from, _to, text) {
            if (!options.filePath || text !== "/") return false;
            // Empty doc: the keeper widget is already there — "/" means
            // "give me the prompt", so focus it instead of inserting a
            // second one (or a stray slash).
            if (
              !docHasRealContent(view.state.doc) &&
              docHasPromptNode(view.state.doc)
            ) {
              const existingId = findPromptNodeId(view.state.doc);
              if (existingId) requestPromptBlobFocus(existingId);
              return true;
            }
            const blobId = newPromptBlobInstanceId();
            const tr = slashSummonTr(view.state, blobId);
            if (!tr) return false;
            view.dispatch(tr);
            requestPromptBlobFocus(blobId);
            return true;
          },
        },
        appendTransaction(transactions, _oldState, newState) {
          if (!options.filePath) return null;
          if (!transactions.some((tr) => tr.docChanged)) return null;
          // Became-empty reinsert: no focus request — the user's cursor is
          // in the editor and must stay there.
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
    ];
  },
});
