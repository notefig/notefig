/**
 * Pure ProseMirror helpers for the aiPrompt node — no React, no host. Split
 * from node-view.tsx because the widget chrome needs `docHasRealContent` for
 * its dismiss semantics, and importing the node view from the chrome would
 * close an import cycle (the view renders the chrome).
 */
import type { Node as PMNode, ResolvedPos } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { PROMPT_DRAFT_NODE_NAME, PROMPT_NODE_NAME } from "./node";

/**
 * Node types that a document can hold and still count as empty. The widget
 * itself is one (it may serialize to nothing); the rest are the host
 * editor's — frontmatter today — which the app declares here rather than
 * this module reaching into the app's schema kit to learn the name.
 *
 * Kept as mutable module state, registered once at editor construction,
 * because the emptiness rule is consulted from ProseMirror plugin callbacks
 * that have no host in scope. A name registered twice is a no-op.
 */
const contentlessNodeNames = new Set<string>([PROMPT_NODE_NAME]);

export function registerContentlessNodeName(name: string): void {
  contentlessNodeNames.add(name);
}

/** Real content = anything that would serialize to markdown BODY: text, or
 *  a leaf that isn't in the contentless set (image, horizontal rule, …).
 *  Empty paragraphs, the widget itself, and the frontmatter node don't count
 *  — a document whose body is empty should get the prompt widget even when
 *  it carries frontmatter (MET-137). */
export function docHasRealContent(doc: PMNode): boolean {
  let found = false;
  doc.descendants((node) => {
    if (found) return false;
    // A widget's draft is the user's half-written prompt, not the
    // document's content: it never serializes, so a document holding only
    // a draft is still empty on disk. Skipping the subtree is what keeps
    // the empty-doc keeper, the "/" summon and the dismiss semantics
    // working once the composer became document content — without it the
    // first typed character would flip this to true.
    if (node.type.name === PROMPT_NODE_NAME) return false;
    if (node.isText) {
      if (node.text?.trim()) found = true;
      return false;
    }
    if (node.isLeaf && !contentlessNodeNames.has(node.type.name)) {
      found = true;
    }
    return !found;
  });
  return found;
}

export function docHasPromptNode(doc: PMNode): boolean {
  let found = false;
  doc.descendants((node) => {
    if (node.type.name === PROMPT_NODE_NAME) found = true;
    return !found;
  });
  return found;
}

/** The first prompt node's instance id, for the empty-doc "/" focus path. */
export function findPromptNodeId(doc: PMNode): string | null {
  let found: string | null = null;
  doc.descendants((node) => {
    if (found === null && node.type.name === PROMPT_NODE_NAME) {
      found = (node.attrs.blobId as string | null) ?? null;
    }
    return found === null;
  });
  return found;
}

/** The document position of the widget carrying `blobId`, or null. */
export function findPromptNodePos(doc: PMNode, blobId: string): number | null {
  let found: number | null = null;
  doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.type.name === PROMPT_NODE_NAME && node.attrs.blobId === blobId) {
      found = pos;
    }
    return found === null;
  });
  return found;
}

/**
 * A widget's draft child: the node, and the range its CONTENT occupies —
 * what a ranged replace addresses (Edit restoring a sent prompt, send
 * clearing the composer) and where the "/" summon puts the caret.
 */
export function promptDraftRange(
  doc: PMNode,
  blobId: string,
): { node: PMNode; from: number; to: number } | null {
  const pos = findPromptNodePos(doc, blobId);
  if (pos === null) return null;
  const widget = doc.nodeAt(pos);
  const draft = widget?.firstChild;
  if (!widget || !draft || draft.type.name !== PROMPT_DRAFT_NODE_NAME) {
    return null;
  }
  // +1 into the widget, +1 into the draft = the start of its inline content.
  const from = pos + 2;
  return { node: draft, from, to: from + draft.content.size };
}

/**
 * The draft the selection sits in, if any — the guard every composer key
 * binding shares, and how the widget's chrome learns that the caret is in
 * its own text.
 */
export function selectionDraft(state: {
  selection: { $from: ResolvedPos };
}): { blobId: string; node: PMNode; from: number; to: number } | null {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    if ($from.node(depth).type.name !== PROMPT_DRAFT_NODE_NAME) continue;
    const draft = $from.node(depth);
    const widget = $from.node(depth - 1);
    const blobId = widget.attrs.blobId as string | null;
    if (!blobId) return null;
    const from = $from.start(depth);
    return { blobId, node: draft, from, to: from + draft.content.size };
  }
  return null;
}

/**
 * Widget-instance identity (the `blobId` attr): editor-local UI state key,
 * deliberately not part of the agent id family in shared/agent/ids.ts —
 * it never crosses the service boundary.
 */
export function newPromptBlobInstanceId(): string {
  return `blob_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/** Ancestor types "/" is allowed to summon through: top-level paragraphs
 *  and paragraphs nested purely in bullet/ordered/task lists (any indent
 *  depth). Blockquotes, code blocks, and table cells keep typing "/"
 *  normally (MET-93 chose lists as the nested context worth summoning in). */
const SUMMONABLE_ANCESTORS = new Set([
  "bulletList",
  "orderedList",
  "listItem",
  "taskList",
  "taskItem",
]);

/**
 * The "/" summon: replace the empty paragraph the cursor sits in with a
 * `summoned` aiPrompt node. Null unless the cursor is in an empty paragraph
 * that is a direct child of the doc or nested only in lists — "/" mid-text,
 * in code blocks, or blockquotes types normally. Deliberately a
 * regular history transaction (⌘Z restores the empty paragraph) and NOT
 * autosave-exempt: dropping a mid-doc empty paragraph can change the
 * serialized blank lines.
 */
export function slashSummonTr(
  state: EditorState,
  blobId: string,
): Transaction | null {
  const { selection } = state;
  if (!(selection instanceof TextSelection) || !selection.empty) return null;
  const { $from } = selection;
  const paragraph = $from.parent;
  if (paragraph.type.name !== "paragraph" || paragraph.content.size !== 0) {
    return null;
  }
  const depth = $from.depth;
  if (depth < 1) return null;
  for (let d = 1; d < depth; d++) {
    if (!SUMMONABLE_ANCESTORS.has($from.node(d).type.name)) return null;
  }
  const type = state.schema.nodes[PROMPT_NODE_NAME];
  if (!type) return null;
  // Belt over the ancestor allowlist: the parent's content expression must
  // actually admit the widget where the paragraph sits (listItem does via
  // PromptHostListItem in editor-schema-kit.ts).
  const index = $from.index(depth - 1);
  if (!$from.node(depth - 1).canReplaceWith(index, index + 1, type)) {
    return null;
  }
  const from = $from.before(depth);
  // createAndFill, not create: the widget's content expression requires a
  // draft child, and a node built without one is invalid — it renders with
  // no contentDOM, so there is nowhere to type.
  const node = type.createAndFill({ summoned: true, blobId });
  if (!node) return null;
  const tr = state.tr.replaceWith(from, $from.after(depth), node);
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

/**
 * A document whose last block is the widget has nowhere to put the caret:
 * the atom is the only thing there, so there is no text position to click
 * into. That is the shape a file holding just a persisted widget marker
 * parses to (MET-163), and the shape the keeper has always relied on the
 * empty document's own paragraph to avoid.
 *
 * Returns the repair transaction, or null when a landing spot already
 * exists. An empty trailing paragraph serializes to nothing, so this never
 * changes the file — callers mark it UI-only for that reason.
 */
export function trailingParagraphTr(state: EditorState): Transaction | null {
  const last = state.doc.lastChild;
  if (!last || last.type.name !== PROMPT_NODE_NAME) return null;
  const paragraph = state.schema.nodes.paragraph?.create();
  if (!paragraph) return null;
  return state.tr.insert(state.doc.content.size, paragraph);
}
