/**
 * Renderer side of the aiPrompt node (schema base + no-op markdown
 * serializer live in editor-schema-kit.ts; pure doc helpers in
 * ai-prompt-utils.ts): the React node view hosting the PromptBlob widget,
 * the empty-document keeper, and the "/" summon.
 *
 * Keeper — the "active by default on new documents" rule: an editor whose
 * document has no real content always carries exactly one aiPrompt node at
 * its end, and it comes back if deleted while the doc is still empty.
 * Keeper transactions are UI-only: they don't join the undo history (a ⌘Z
 * fight with reinsertion) and they carry UI_ONLY_TRANSACTION_META so the
 * autosave path ignores them.
 *
 * Summon — typing "/" in an empty top-level paragraph replaces it with a
 * focused widget (`summoned: true`); Esc or a second "/" while the composer
 * is empty reverts it to a literal "/". In an empty doc the keeper widget
 * already exists, so "/" just focuses it. Docs with content are never
 * force-populated, and deleting the widget there is final.
 */
import { ReactNodeViewRenderer, NodeViewWrapper } from "@tiptap/react";
import type { NodeViewProps } from "@tiptap/react";
import { Plugin } from "@tiptap/pm/state";
import {
  AiPromptNodeBase,
  UI_ONLY_TRANSACTION_META,
} from "./editor-schema-kit";
import {
  docHasPromptNode,
  docHasRealContent,
  revertToSlashTr,
  slashSummonTr,
} from "./ai-prompt-utils";
import { PromptBlob } from "@/components/agent/prompt-blob";
import { requestPromptBlobFocus } from "@/components/agent/prompt-blob-store";
import type { EditorState, Transaction } from "@tiptap/pm/state";

export interface AiPromptNodeOptions {
  /** Absolute path of the host document (empty in schema-only contexts). */
  filePath: string;
  /** Workspace root the prompt's session is scoped to. */
  basePath: string;
}

/** The keeper's insertion, or null when the doc doesn't need one. */
function appendPromptTr(state: EditorState): Transaction | null {
  if (docHasRealContent(state.doc) || docHasPromptNode(state.doc)) return null;
  const type = state.schema.nodes[AiPromptNodeBase.name];
  if (!type) return null;
  return state.tr
    .insert(state.doc.content.size, type.create())
    .setMeta("addToHistory", false)
    .setMeta(UI_ONLY_TRANSACTION_META, true);
}

function AiPromptNodeView(props: NodeViewProps) {
  const { filePath, basePath } = props.extension
    .options as AiPromptNodeOptions;
  if (!filePath || !basePath) return <NodeViewWrapper />;

  const removeNode = (options?: { insertSlash?: boolean }) => {
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
      className="not-prose my-3"
    >
      <PromptBlob
        workspacePath={basePath}
        documentPath={filePath}
        editor={props.editor}
        summoned={Boolean(props.node.attrs.summoned)}
        removeNode={removeNode}
      />
    </NodeViewWrapper>
  );
}

export const AiPromptNode = AiPromptNodeBase.extend<AiPromptNodeOptions>({
  addOptions() {
    return { filePath: "", basePath: "" };
  },

  addNodeView() {
    return ReactNodeViewRenderer(AiPromptNodeView);
  },

  onCreate() {
    // Documents open empty (new files) get the widget from the start.
    if (!this.options.filePath) return;
    const tr = appendPromptTr(this.editor.state);
    if (tr) this.editor.view.dispatch(tr);
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
              requestPromptBlobFocus(options.filePath);
              return true;
            }
            const tr = slashSummonTr(view.state);
            if (!tr) return false;
            view.dispatch(tr);
            requestPromptBlobFocus(options.filePath);
            return true;
          },
        },
        appendTransaction(transactions, _oldState, newState) {
          if (!options.filePath) return null;
          if (!transactions.some((tr) => tr.docChanged)) return null;
          return appendPromptTr(newState);
        },
      }),
    ];
  },
});
