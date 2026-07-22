/**
 * Per-WIDGET prompt-blob state, outside React — keyed by the aiPrompt
 * node's `blobId` attr, NOT the document path: a document can hold several
 * widgets ("/" summons), and each must have its own draft and bound turn.
 * Lives outside React because the dock mounts only the selected tab, so
 * component state dies on every tab switch (same reason as
 * composer-draft-store.ts). Unlike drafts, a blob record is read while it
 * changes from outside the component (send rebinds the turn), so this store
 * adds a subscribe/emit for useSyncExternalStore. Ephemeral by design, like
 * the agent collections: nothing persists across app runs, ids never recur,
 * and a stale bound turn (rows gone) simply renders as composing again.
 */
export type PromptBlobRecord = {
  /** Composer text (survives tab unmount). Shared by the initial composer
   *  and the done/error reply row — Edit's `draft || lastSentPrompt`
   *  fallback then means a half-typed reply is never destroyed. */
  draft: string;
  /** The turn this widget is watching, or null while composing. */
  boundTurnId: string | null;
  /** Task captured at send time — the shared session may rotate afterwards,
   *  but this widget stays on the task its turn ran on. */
  boundTaskId: string | null;
  /** Last sent prompt text, for the Edit affordance. */
  lastSentPrompt: string;
};

const EMPTY_RECORD: PromptBlobRecord = {
  draft: "",
  boundTurnId: null,
  boundTaskId: null,
  lastSentPrompt: "",
};

const records = new Map<string, PromptBlobRecord>();
const listeners = new Map<string, Set<() => void>>();

function emit(blobId: string): void {
  for (const listener of listeners.get(blobId) ?? []) listener();
}

/** Stable snapshot — returns the same object until the record changes. */
export function getPromptBlob(blobId: string): PromptBlobRecord {
  return records.get(blobId) ?? EMPTY_RECORD;
}

export function updatePromptBlob(
  blobId: string,
  patch: Partial<PromptBlobRecord>,
): void {
  records.set(blobId, { ...getPromptBlob(blobId), ...patch });
  emit(blobId);
}

/** Unbind the watched turn (dismiss / stale-row reset), keeping the draft. */
export function clearPromptBlobTurn(blobId: string): void {
  updatePromptBlob(blobId, {
    boundTurnId: null,
    boundTaskId: null,
  });
}

export function subscribePromptBlob(
  blobId: string,
  listener: () => void,
): () => void {
  let set = listeners.get(blobId);
  if (!set) {
    set = new Set();
    listeners.set(blobId, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(blobId);
  };
}

// ===== one-shot focus channel =====
//
// The "/" summon happens inside a ProseMirror plugin, which can't reach the
// widget's textarea directly — and at summon time the widget may not even be
// mounted yet (the node view renders on the next React pass). A request
// notifies any mounted widget immediately AND stays pending so a widget that
// mounts right after can consume it. Consuming clears it — focus fires once.

const focusListeners = new Map<string, Set<() => void>>();
const pendingFocus = new Set<string>();

/** Ask the document's prompt widget to focus its composer. */
export function requestPromptBlobFocus(blobId: string): void {
  pendingFocus.add(blobId);
  for (const listener of focusListeners.get(blobId) ?? []) listener();
}

/** One-shot: true (and clears the request) if a focus request is pending. */
export function consumePendingPromptBlobFocus(blobId: string): boolean {
  return pendingFocus.delete(blobId);
}

export function subscribePromptBlobFocus(
  blobId: string,
  listener: () => void,
): () => void {
  let set = focusListeners.get(blobId);
  if (!set) {
    set = new Set();
    focusListeners.set(blobId, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) focusListeners.delete(blobId);
  };
}
