/**
 * Pure ProseMirror helpers for the aiPrompt node — no React. Split from
 * ai-prompt-node.tsx because prompt-blob.tsx needs `docHasRealContent` for
 * its dismiss semantics, and importing the node module from the widget
 * would close an import cycle (the node's view imports the widget).
 */
import type { Node as PMNode } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { AiPromptNodeBase } from "./editor-schema-kit";

/** Real content = anything that would serialize to markdown: text, or a
 *  non-aiPrompt leaf (image, horizontal rule, …). Empty paragraphs and the
 *  widget itself don't count. */
export function docHasRealContent(doc: PMNode): boolean {
  let found = false;
  doc.descendants((node) => {
    if (found) return false;
    if (node.isText) {
      if (node.text?.trim()) found = true;
      return false;
    }
    if (node.isLeaf && node.type.name !== AiPromptNodeBase.name) {
      found = true;
    }
    return !found;
  });
  return found;
}

export function docHasPromptNode(doc: PMNode): boolean {
  let found = false;
  doc.descendants((node) => {
    if (node.type.name === AiPromptNodeBase.name) found = true;
    return !found;
  });
  return found;
}

/** The first prompt node's instance id, for the empty-doc "/" focus path. */
export function findPromptNodeId(doc: PMNode): string | null {
  let found: string | null = null;
  doc.descendants((node) => {
    if (found === null && node.type.name === AiPromptNodeBase.name) {
      found = (node.attrs.blobId as string | null) ?? null;
    }
    return found === null;
  });
  return found;
}

/**
 * Widget-instance identity (the `blobId` attr): editor-local UI state key,
 * deliberately not part of the agent id family in shared/agent/ids.ts —
 * it never crosses the service boundary.
 */
export function newPromptBlobInstanceId(): string {
  return `blob_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * The "/" summon: replace the empty paragraph the cursor sits in with a
 * `summoned` aiPrompt node. Null unless the cursor is in an empty paragraph
 * that is a direct child of the doc — "/" mid-text, in lists, code blocks,
 * or blockquotes types normally. Deliberately a regular history transaction
 * (⌘Z restores the empty paragraph) and NOT autosave-exempt: dropping a
 * mid-doc empty paragraph can change the serialized blank lines.
 */
export function slashSummonTr(
  state: EditorState,
  blobId: string,
): Transaction | null {
  const { selection } = state;
  if (!(selection instanceof TextSelection) || !selection.empty) return null;
  const { $from } = selection;
  if ($from.depth !== 1) return null;
  const paragraph = $from.parent;
  if (paragraph.type.name !== "paragraph" || paragraph.content.size !== 0) {
    return null;
  }
  const type = state.schema.nodes[AiPromptNodeBase.name];
  if (!type) return null;
  const from = $from.before(1);
  const tr = state.tr.replaceWith(
    from,
    $from.after(1),
    type.create({ summoned: true, blobId }),
  );
  // Explicit, like revertToSlashTr/removeToParagraphTr below — leaving this
  // to ProseMirror's default post-replace mapping (an implicit NodeSelection
  // on the atom, since the old cursor position no longer resolves) left the
  // history item without a recorded selection, which could make ⌘Z land the
  // cursor in the wrong place instead of restoring the pre-summon position.
  return tr.setSelection(NodeSelection.create(tr.doc, from));
}

/**
 * The revert half of the "/" contract: the widget at [pos, pos+nodeSize)
 * becomes a paragraph holding a literal "/", cursor placed after it —
 * exactly what Esc or a second "/" in the empty composer should leave
 * behind.
 */
export function revertToSlashTr(
  state: EditorState,
  pos: number,
  nodeSize: number,
): Transaction {
  const paragraph = state.schema.nodes.paragraph.create(
    null,
    state.schema.text("/"),
  );
  const tr = state.tr.replaceWith(pos, pos + nodeSize, paragraph);
  return tr.setSelection(TextSelection.create(tr.doc, pos + 2));
}

/**
 * Backspace-dismiss: the widget at [pos, pos+nodeSize) becomes an empty
 * paragraph, cursor inside — as if the summoning "/" was never typed. A
 * normal history transaction like slashSummonTr/revertToSlashTr (⌘Z
 * restores the widget) and NOT autosave-exempt.
 */
export function removeToParagraphTr(
  state: EditorState,
  pos: number,
  nodeSize: number,
): Transaction {
  const paragraph = state.schema.nodes.paragraph.create();
  const tr = state.tr.replaceWith(pos, pos + nodeSize, paragraph);
  return tr.setSelection(TextSelection.create(tr.doc, pos + 1));
}
