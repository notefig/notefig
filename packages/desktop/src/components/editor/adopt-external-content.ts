/**
 * Differential adoption (MET-174): external file content enters a live
 * editor as ONE ordinary transaction instead of a wholesale `setContent`.
 *
 * Wholesale replacement destroys node identity — prompt widgets, half-typed
 * drafts, the caret, and every mapped position die even when the external
 * write touched one paragraph. The industry pattern (Obsidian's external
 * merge, VS Code buffer reload, CodeMirror 6, Cursor's apply) is to diff
 * the incoming content against what the editor holds and dispatch minimal
 * edits, so untouched regions keep identity and positions map through. The
 * doc-to-doc diff engine is the vendored recreateTransform
 * (src/vendor/prosemirror-recreate-transform, Apache-2.0, Fidus Writer
 * lineage) — dormant upstream, so it lives in-tree.
 *
 * Prompt widgets get one guarantee on top of the diff: a widget node
 * present before adoption and absent after it is re-inserted at the
 * deterministic mapped position of where it stood (`resolveDroppedWidget`
 * is the policy seam). An agent whose rewrite omits the widget markers —
 * the common case, since harnesses rewrite whole files — therefore cannot
 * delete widgets; the caller is told how many were re-asserted so it can
 * write the markers back to disk.
 *
 * The diff has a budget: pathological documents fall back to the old
 * `setContent` path (drafts still carried), because a multi-second
 * synchronous diff is worse than a lost caret.
 */
import type { Editor } from "@tiptap/core";
import type { JSONContent } from "@tiptap/core";
import type { Node as PMNode, NodeType } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { PROMPT_NODE_NAME } from "@notefig/widgets";
import { recreateTransform } from "@/vendor/prosemirror-recreate-transform/recreateTransform";
import { carryDraftsForward } from "./draft-only-edit";

/** Set on the adoption transaction; the autosave update handler skips it —
 *  adoption must not schedule a save of content the file already holds.
 *  (Marker write-back after re-insertion is explicit, not via autosave.) */
export const ADOPTION_TRANSACTION_META = "notefig-external-adoption";

/** Combined nodeSize past which the synchronous diff is not attempted.
 *  ~an order of magnitude above any document seen in real use; the CZI
 *  timeout patch for this engine exists because unbounded runs do blow up. */
const MAX_DIFF_NODE_SIZE = 400_000;

export type AdoptionResult = {
  /** "diffed" = minimal transaction; "replaced" = setContent fallback. */
  mode: "diffed" | "replaced";
  /** Widgets the incoming content dropped that were re-asserted. When > 0
   *  the editor holds markers the file lacks — callers push a write-back. */
  reinsertedWidgets: number;
};

/**
 * Policy for a widget the external edit genuinely landed on (MET-174).
 * v1: always re-assert at the mapped position — widget deletion stays a
 * user gesture. "orphan" is the stub for the designed-but-unbuilt pathway:
 * flip the widget to an explicit orphaned state (kept in the blob/task
 * stores, surfaced in the widget list with re-place/dismiss) instead of
 * putting it back in the document. Wire it here when that state exists.
 */
function resolveDroppedWidget(_node: PMNode): "reinsert" | "orphan" {
  return "reinsert";
}

/** TODO(MET-174): the orphaned-widget pathway. Today this only happens when
 *  no valid re-insertion point exists (or policy opts out); the widget node
 *  leaves the document while its task/blob state lives on unreferenced. */
function orphanDroppedWidget(node: PMNode): void {
  console.warn(
    "[adoption] prompt widget left the document with no re-insertion point",
    { blobId: node.attrs.blobId, taskId: node.attrs.taskId },
  );
}

function collectWidgets(doc: PMNode): Array<{ pos: number; node: PMNode }> {
  const found: Array<{ pos: number; node: PMNode }> = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== PROMPT_NODE_NAME) return true;
    found.push({ pos, node });
    return false;
  });
  return found;
}

function widgetBlobIds(doc: PMNode): Set<string> {
  const ids = new Set<string>();
  doc.descendants((node) => {
    if (node.type.name !== PROMPT_NODE_NAME) return true;
    const blobId = node.attrs.blobId as string | null;
    if (blobId) ids.add(blobId);
    return false;
  });
  return ids;
}

/** Nearest position at or above `rawPos` where `nodeType` may be inserted:
 *  walk outward from the resolved position until a parent accepts it. */
function findInsertPos(
  doc: PMNode,
  rawPos: number,
  nodeType: NodeType,
): number | null {
  const pos = Math.max(0, Math.min(rawPos, doc.content.size));
  const $pos = doc.resolve(pos);
  for (let depth = $pos.depth; depth >= 0; depth--) {
    const parent = $pos.node(depth);
    const index = $pos.index(depth);
    if (parent.canReplaceWith(index, index, nodeType)) {
      return depth === $pos.depth ? pos : $pos.posAtIndex(index, depth);
    }
  }
  return null;
}

/**
 * Replace the editor's content with `incoming` (parsed external file
 * content), preserving as much editor state as the diff allows. Dispatches
 * exactly one transaction (or one setContent fallback). Callers still own
 * `DocumentSync.commitAdoption` and any marker write-back.
 */
export function adoptExternalContent(
  editor: Editor,
  incoming: JSONContent,
  options: { maxDiffNodeSize?: number } = {},
): AdoptionResult {
  const maxDiffNodeSize = options.maxDiffNodeSize ?? MAX_DIFF_NODE_SIZE;
  const oldDoc = editor.state.doc;
  // Drafts ride along in both modes: harmless when the diff would have
  // kept them anyway, load-bearing for the fallback.
  const prepared = carryDraftsForward(incoming, oldDoc);

  let newDoc: PMNode | null = null;
  try {
    newDoc = editor.schema.nodeFromJSON(prepared);
    newDoc.check();
  } catch {
    newDoc = null;
  }

  if (!newDoc || oldDoc.nodeSize + newDoc.nodeSize > maxDiffNodeSize) {
    return applyReplaceFallback(editor, prepared, oldDoc);
  }

  try {
    const diff = recreateTransform(oldDoc, newDoc, {
      complexSteps: true,
      wordDiffs: true,
      simplifyDiff: true,
    });
    const tr = editor.state.tr;
    for (const step of diff.steps) {
      const applied = tr.maybeStep(step);
      if (applied.failed) throw new Error(applied.failed);
    }
    const draftCaret = captureDraftCaret(editor);
    const reinsertedWidgets = reassertDroppedWidgets(oldDoc, tr, (pos) =>
      tr.mapping.map(pos),
    );
    restoreDraftCaret(tr, draftCaret);
    tr.setMeta(ADOPTION_TRANSACTION_META, true);
    editor.view.dispatch(tr);
    return { mode: "diffed", reinsertedWidgets };
  } catch (error) {
    // A diff the engine cannot express (or a step that no longer applies)
    // degrades to the historical behavior rather than failing adoption.
    console.warn(
      "[adoption] differential adoption failed, falling back to replace",
      error,
    );
    return applyReplaceFallback(editor, prepared, oldDoc);
  }
}

/**
 * The setContent fallback with the same widget guarantees as the diff
 * path: dropped widgets are re-asserted (at proportionally scaled
 * positions — a wholesale replace has no step mapping) and a draft caret
 * is restored. Without this, an oversized document or a diff-engine
 * failure coinciding with a marker-dropping rewrite deleted widgets for
 * good.
 */
function applyReplaceFallback(
  editor: Editor,
  prepared: JSONContent,
  oldDoc: PMNode,
): AdoptionResult {
  const draftCaret = captureDraftCaret(editor);
  editor.commands.setContent(prepared, { emitUpdate: false });
  const tr = editor.state.tr;
  const oldSize = Math.max(oldDoc.content.size, 1);
  const scale = tr.doc.content.size / oldSize;
  const reinsertedWidgets = reassertDroppedWidgets(oldDoc, tr, (pos) =>
    Math.round(pos * scale),
  );
  restoreDraftCaret(tr, draftCaret);
  tr.setMeta(ADOPTION_TRANSACTION_META, true);
  if (tr.steps.length > 0 || tr.selectionSet) {
    editor.view.dispatch(tr);
  }
  return { mode: "replaced", reinsertedWidgets };
}

/** The caret's home when it sits inside a widget's draft: which widget
 *  (by node identity — survives re-assertion, which re-inserts the same
 *  node instance) and how far into the draft text. */
type DraftCaret = { widget: PMNode; offset: number };

function captureDraftCaret(editor: Editor): DraftCaret | null {
  const { $head } = editor.state.selection;
  for (let depth = $head.depth; depth > 0; depth--) {
    if ($head.node(depth).type.name !== PROMPT_NODE_NAME) continue;
    // draft text starts after the widget and draft opening tokens
    const draftStart = $head.before(depth) + 2;
    return { widget: $head.node(depth), offset: $head.pos - draftStart };
  }
  return null;
}

/**
 * A caret that was typing in a draft must still be typing in that draft
 * after adoption (the selection-side twin of carryDraftsForward). The
 * default mapping loses it whenever the diff or the re-assertion rebuilt
 * the widget: the caret collapses to the replaced range's boundary and
 * lands in the neighboring block — the "caret drops a line on agent write"
 * bug. Deterministic restore: same widget, same offset (clamped).
 */
function restoreDraftCaret(
  tr: { doc: PMNode; setSelection: (sel: TextSelection) => unknown },
  caret: DraftCaret | null,
): void {
  if (!caret) return;
  const blobId = caret.widget.attrs.blobId as string | null;
  let widgetPos = -1;
  tr.doc.descendants((node, pos) => {
    if (widgetPos >= 0) return false;
    if (node.type.name !== PROMPT_NODE_NAME) return true;
    if (node === caret.widget || (blobId && node.attrs.blobId === blobId)) {
      widgetPos = pos;
    }
    return false;
  });
  if (widgetPos < 0) return; // widget genuinely gone (orphan pathway)
  const draft = tr.doc.nodeAt(widgetPos)?.firstChild;
  if (!draft) return;
  const draftStart = widgetPos + 2;
  const target = draftStart + Math.min(Math.max(caret.offset, 0), draft.content.size);
  // Unconditional: when the mapping already kept the caret in place this
  // re-sets the identical position; when it collapsed the caret to a
  // replaced range's edge (including edges of the re-inserted widget
  // itself), this is the correction.
  tr.setSelection(TextSelection.create(tr.doc, target));
}

/** Re-insert widgets the diff removed, at their mapped positions. Runs on
 *  the open transaction so each insertion participates in the mapping. */
function reassertDroppedWidgets(
  oldDoc: PMNode,
  tr: { doc: PMNode; insert: (pos: number, node: PMNode) => unknown },
  mapPos: (pos: number) => number,
): number {
  let reinserted = 0;
  const survivors = widgetBlobIds(tr.doc);
  for (const { pos, node } of collectWidgets(oldDoc)) {
    const blobId = node.attrs.blobId as string | null;
    // Bound widgets survive when the incoming content kept their marker;
    // unbound widgets (a summoned/queued composer) are never in the file,
    // so an adoption always drops them and they are always re-asserted.
    if (blobId && survivors.has(blobId)) continue;
    if (resolveDroppedWidget(node) !== "reinsert") {
      orphanDroppedWidget(node);
      continue;
    }
    const insertAt = findInsertPos(tr.doc, mapPos(pos), node.type);
    if (insertAt === null) {
      orphanDroppedWidget(node);
      continue;
    }
    tr.insert(insertAt, node);
    reinserted++;
  }
  return reinserted;
}
