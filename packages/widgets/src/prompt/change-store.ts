/**
 * What each prompt widget's latest round changed in each document — the
 * review half of the widget's state, beside the binding in ./store.ts and
 * governed by the same rules: in memory only, keyed by ids that never
 * recur, and gone the moment the widget binds a different turn (a new
 * send, a dismiss, an edit — see `updatePromptBlob`).
 *
 * Ranges are document positions, so they are kept per document and only
 * the editor holding that document moves them (./change-tracking.ts maps
 * them through every transaction and writes them back here). Keeping them
 * here rather than only in the editor is what lets a recreated editor pick
 * them up again, and what lets UI outside the document — the widget's own
 * face — read them without reaching into ProseMirror.
 *
 * This module knows nothing about who decides a change belongs to a round
 * (the app, via PROMPT_CHANGE_META on the transaction) or how changes look
 * (./change-gutter.ts): it is the contract between those two.
 */
import { useMemo, useSyncExternalStore } from "react";

/**
 * Transaction meta naming the round a transaction's edits belong to. The
 * app sets it on the adoption transaction that brings an agent's write into
 * the editor; every range the transaction's steps touch is recorded as a
 * change by that round.
 */
export const PROMPT_CHANGE_META = "notefigPromptChange";

export type PromptChangeAttribution = { blobId: string; turnId: string };

/**
 * One changed span. `from === to` marks a pure deletion — nothing is left to
 * highlight, but the spot where content went is still a change to review.
 */
export type PromptChange = PromptChangeAttribution & {
  from: number;
  to: number;
};

const EMPTY: readonly PromptChange[] = Object.freeze([]);

const byDocument = new Map<string, readonly PromptChange[]>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Stable snapshot — the same array until the document's changes change. */
export function getDocumentPromptChanges(
  documentPath: string,
): readonly PromptChange[] {
  return byDocument.get(documentPath) ?? EMPTY;
}

/** Written by the editor holding the document, after mapping. */
export function setDocumentPromptChanges(
  documentPath: string,
  changes: readonly PromptChange[],
): void {
  if (getDocumentPromptChanges(documentPath) === changes) return;
  if (changes.length === 0) byDocument.delete(documentPath);
  else byDocument.set(documentPath, changes);
  emit();
}

/**
 * The one widget under review, or null. Review is a mode, not a filter:
 * only that widget's changes are marked in the documents, and starting a
 * review on another widget ends this one.
 */
let reviewing: string | null = null;

export function getPromptReview(): string | null {
  return reviewing;
}

/** Start reviewing `blobId`, or end the review with null. */
export function setPromptReview(blobId: string | null): void {
  if (reviewing === blobId) return;
  reviewing = blobId;
  emit();
}

/** Forget every change a widget's rounds made, in every document. */
export function discardPromptChanges(blobId: string): void {
  // Nothing left to review once the changes are gone.
  let changed = reviewing === blobId;
  if (changed) reviewing = null;
  for (const [documentPath, changes] of byDocument) {
    const kept = changes.filter((change) => change.blobId !== blobId);
    if (kept.length === changes.length) continue;
    changed = true;
    if (kept.length === 0) byDocument.delete(documentPath);
    else byDocument.set(documentPath, kept);
  }
  if (changed) emit();
}

export function subscribePromptChanges(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Changed spans per document for one widget. Pure, for the hook below. */
export function countPromptChanges(
  blobId: string,
  documents: ReadonlyMap<string, readonly PromptChange[]> = byDocument,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [documentPath, changes] of documents) {
    const count = changes.filter((change) => change.blobId === blobId).length;
    if (count > 0) counts.set(documentPath, count);
  }
  return counts;
}

/** Live `countPromptChanges` for a widget's face. */
export function usePromptChangeCounts(blobId: string): Map<string, number> {
  // The snapshot is a string so useSyncExternalStore can compare it by
  // value — a fresh Map per read would re-render forever.
  const key = useSyncExternalStore(subscribePromptChanges, () =>
    JSON.stringify([...countPromptChanges(blobId)]),
  );
  return useMemo(
    () => new Map(JSON.parse(key) as Array<[string, number]>),
    [key],
  );
}

/**
 * The widget's review colour, one of the theme's chart hues picked by id —
 * the same widget always lands on the same hue, in the document and on its
 * face. A CSS colour expression, usable anywhere a colour is.
 */
export function promptChangeColor(blobId: string, alpha = 1): string {
  let hash = 0;
  for (let i = 0; i < blobId.length; i++) {
    hash = (hash * 31 + blobId.charCodeAt(i)) | 0;
  }
  const hue = (Math.abs(hash) % 5) + 1;
  return alpha === 1
    ? `hsl(var(--chart-${hue}))`
    : `hsl(var(--chart-${hue}) / ${alpha})`;
}
