/**
 * What each prompt widget's rounds changed in each document — the review
 * half of the widget's state, owned by the prompt service
 * (./widgets-service.ts, `prompts.review`) and governed by its rules: keyed
 * by ids that never recur, and gone the moment the widget binds a different
 * turn (a new send, a dismiss, an edit — the service discards them).
 *
 * One copy, read one way. At startup it takes up what the app saved
 * (MET-251); from then on the editor holding a document maps its changes
 * through every transaction (./change-tracking.ts) and writes them back
 * here, and the app keeps the saved copy in step. Changes are positions in
 * the document they were mapped onto, so those of a document no editor
 * holds — saved by an earlier run, or left by an editor that closed — wait
 * `unchecked` until an editor opens it and checks its fingerprint: the
 * same document takes them up, a changed one drops them. Until then they
 * count as they are — the widget's face reads the same counts whether a
 * document is open or not.
 *
 * This knows nothing about who decides a change belongs to a round (the
 * app, via PROMPT_CHANGE_META on the transaction) or how changes look
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

/** A document's review ranges, with the fingerprint of the document they
 *  were mapped onto — they only mean something against that document. */
export type SavedReviewRanges = {
  fingerprint: string;
  changes: PromptChange[];
};

/** Where review ranges are kept between runs. */
export interface ReviewRangeStore {
  /** Every document's saved ranges, once what was stored has loaded. */
  loadAll(): Promise<ReadonlyMap<string, SavedReviewRanges>>;
  save(documentPath: string, saved: SavedReviewRanges): void;
  /** Drop every range a widget's rounds made, in every document. */
  forget(blobId: string): void;
}

/** Keeps nothing: for a service with no app behind it. */
export const NO_SAVED_REVIEW_RANGES: ReviewRangeStore = {
  loadAll: async () => new Map(),
  save() {},
  forget() {},
};

export type PromptReview = ReturnType<typeof createPromptReview>;

const EMPTY: readonly PromptChange[] = Object.freeze([]);

type Entry = { changes: readonly PromptChange[]; unchecked: string | null };

export function createPromptReview(saved: ReviewRangeStore) {
  const byDocument = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  /** What was last saved per document, so an unchanged save is skipped. */
  const lastSaved = new Map<string, string>();
  let reviewing: string | null = null;

  const emit = () => {
    for (const listener of [...listeners]) listener();
  };

  void saved
    .loadAll()
    .then((documents) => {
      for (const [documentPath, { fingerprint, changes }] of documents) {
        // An editor that already tracks changes of its own keeps them.
        if (byDocument.get(documentPath)?.changes.length) continue;
        byDocument.set(documentPath, { changes, unchecked: fingerprint });
      }
      if (documents.size > 0) emit();
    })
    .catch((error) => {
      console.error("Failed to load review ranges:", error);
    });

  return {
    /** A document's changes. Stable: the same array until they change. */
    changes: (documentPath: string): readonly PromptChange[] =>
      byDocument.get(documentPath)?.changes ?? EMPTY,
    /** The fingerprint of the document saved changes were mapped onto,
     *  while no editor has checked them; null once one has. */
    unchecked: (documentPath: string): string | null =>
      byDocument.get(documentPath)?.unchecked ?? null,
    /** The editor holding the document wrote its changes: checked. */
    set(documentPath: string, changes: readonly PromptChange[]): void {
      const current = byDocument.get(documentPath);
      if (current?.changes === changes && current.unchecked === null) return;
      // Kept even when empty: an editor has said what this document's
      // changes are, and that outranks anything saved for it.
      byDocument.set(documentPath, { changes, unchecked: null });
      emit();
    },
    /** No editor holds the document any more: its changes wait unchecked
     *  against `fingerprint` until one does. */
    release(documentPath: string, fingerprint: string): void {
      const current = byDocument.get(documentPath);
      if (current) byDocument.set(documentPath, { ...current, unchecked: fingerprint });
    },
    /** Keep a document's changes past this run. */
    save(documentPath: string, ranges: SavedReviewRanges): void {
      const key = JSON.stringify(ranges);
      if (lastSaved.get(documentPath) === key) return;
      lastSaved.set(documentPath, key);
      saved.save(documentPath, ranges);
    },
    /** Forget every change a widget's rounds made, in every document. */
    discard(blobId: string): void {
      // Nothing left to review once the changes are gone.
      let changed = reviewing === blobId;
      if (changed) reviewing = null;
      for (const [documentPath, entry] of byDocument) {
        const kept = entry.changes.filter((change) => change.blobId !== blobId);
        if (kept.length === entry.changes.length) continue;
        changed = true;
        byDocument.set(documentPath, { ...entry, changes: kept });
      }
      saved.forget(blobId);
      if (changed) emit();
    },
    /** A widget's changed spans, per document. */
    counts(blobId: string): Map<string, number> {
      const counts = new Map<string, number>();
      for (const [documentPath, { changes }] of byDocument) {
        const count = changes.filter((change) => change.blobId === blobId).length;
        if (count > 0) counts.set(documentPath, count);
      }
      return counts;
    },
    /** The one widget under review, or null. Review is a mode, not a
     *  filter: only that widget's changes are marked in the documents, and
     *  starting a review on another widget ends this one. */
    reviewing: (): string | null => reviewing,
    setReviewing(blobId: string | null): void {
      if (reviewing === blobId) return;
      reviewing = blobId;
      emit();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** Live `review.counts` for a widget's face. */
export function usePromptChangeCounts(
  review: PromptReview,
  blobId: string,
): Map<string, number> {
  // The snapshot is a string so useSyncExternalStore can compare it by
  // value — a fresh Map per read would re-render forever.
  const key = useSyncExternalStore(review.subscribe, () =>
    JSON.stringify([...review.counts(blobId)]),
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
