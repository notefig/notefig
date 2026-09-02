/**
 * "This transaction changed nothing the file will ever see."
 *
 * A prompt widget's draft is document content (`aiPrompt > promptDraft`), so
 * typing in a composer produces ordinary document transactions — but the
 * widget's markdown serializer writes its marker from attrs alone and never
 * renders children, so none of that text can reach the file.
 *
 * The autosave path has to know, because `DocumentSync.runSaveLoop` writes
 * whatever it serializes with no equality check: without this every typing
 * pause in a composer would re-write the file and churn the watcher. It also
 * keeps the debounce window clear, which matters for a second reason — the
 * adoption path declines to adopt external changes while edits sit in that
 * window, and a user typing a prompt must not block an agent's write to the
 * same file.
 *
 * Derived from the step ranges rather than from a transaction meta: composer
 * keystrokes come out of ProseMirror's own input handling, not from code
 * that could tag them (which is what UI_ONLY_TRANSACTION_META does for the
 * keeper's insertions).
 */
import type { JSONContent } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import { PROMPT_NODE_NAME } from "@notefig/widgets";

/**
 * True when every step of `transaction` lands inside a prompt widget.
 *
 * Ranges are resolved against the state BEFORE the transaction, which is
 * where the step's own positions are meaningful. A transaction with no
 * document steps is not draft-only — it has nothing to say either way, and
 * the caller has already established that the document changed.
 */
export function isDraftOnlyEdit(transaction: Transaction): boolean {
  if (!transaction.docChanged) return false;
  let ranges = 0;
  let allInside = true;
  transaction.steps.forEach((step, index) => {
    // Each step's positions are meaningful against the document it was
    // applied to, which `docs` records step by step.
    const before = transaction.docs[index] ?? transaction.doc;
    step.getMap().forEach((from, to) => {
      ranges++;
      if (!isInsidePrompt(before, from, to)) allInside = false;
    });
  });
  return ranges > 0 && allInside;
}

/** Whether [from, to] lies wholly within one prompt widget. */
function isInsidePrompt(
  doc: Transaction["doc"],
  from: number,
  to: number,
): boolean {
  if (from > doc.content.size || to > doc.content.size) return false;
  const $from = doc.resolve(from);
  for (let depth = $from.depth; depth > 0; depth--) {
    if ($from.node(depth).type.name !== PROMPT_NODE_NAME) continue;
    // The range must end in the same widget too, or the step is also
    // touching the document around it.
    return to <= $from.end(depth);
  }
  return false;
}

/**
 * Carry live drafts into a document the file is about to replace.
 *
 * Adoption rebuilds the whole document from disk, and a draft is not on
 * disk — the widget's marker comment records its session, not its text. So
 * a re-parsed widget comes back with an empty draft, and an agent writing
 * the file while the user is mid-sentence would erase what they were
 * typing. Matching on blobId (which the marker does carry) puts each live
 * draft back into its own widget; a widget the write removed keeps nothing,
 * which is correct — it is gone.
 *
 * Mutates the incoming doc JSON in place and returns it: it was just built
 * by the conversion worker for this one call and has no other reader.
 */
export function carryDraftsForward(
  incoming: JSONContent,
  live: PMNode,
): JSONContent {
  const drafts = new Map<string, JSONContent | undefined>();
  live.descendants((node) => {
    if (node.type.name !== PROMPT_NODE_NAME) return true;
    const blobId = node.attrs.blobId as string | null;
    const draft = node.firstChild;
    if (blobId && draft && draft.content.size > 0) {
      drafts.set(blobId, draft.toJSON() as JSONContent);
    }
    return false;
  });
  if (drafts.size === 0) return incoming;

  const visit = (node: JSONContent) => {
    if (node.type === PROMPT_NODE_NAME) {
      const blobId = node.attrs?.blobId as string | undefined;
      const draft = blobId ? drafts.get(blobId) : undefined;
      if (draft) node.content = [draft];
      return;
    }
    node.content?.forEach(visit);
  };
  incoming.content?.forEach(visit);
  return incoming;
}
