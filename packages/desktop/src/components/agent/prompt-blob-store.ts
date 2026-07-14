/**
 * Per-document prompt-blob state, outside React — the dock mounts only the
 * selected tab, so the widget's component state dies on every tab switch
 * (same reason as composer-draft-store.ts). Unlike drafts, a blob record is
 * read while it changes from outside the component (send rebinds the turn),
 * so this store adds a subscribe/emit for useSyncExternalStore. Ephemeral by
 * design, like the agent collections: nothing persists across app runs, and
 * a stale bound turn (rows gone) simply renders as composing again.
 */
export type PromptBlobRecord = {
  /** Composer text (survives tab unmount). */
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

function emit(documentPath: string): void {
  for (const listener of listeners.get(documentPath) ?? []) listener();
}

/** Stable snapshot — returns the same object until the record changes. */
export function getPromptBlob(documentPath: string): PromptBlobRecord {
  return records.get(documentPath) ?? EMPTY_RECORD;
}

export function updatePromptBlob(
  documentPath: string,
  patch: Partial<PromptBlobRecord>,
): void {
  records.set(documentPath, { ...getPromptBlob(documentPath), ...patch });
  emit(documentPath);
}

/** Unbind the watched turn (dismiss / stale-row reset), keeping the draft. */
export function clearPromptBlobTurn(documentPath: string): void {
  updatePromptBlob(documentPath, { boundTurnId: null, boundTaskId: null });
}

export function subscribePromptBlob(
  documentPath: string,
  listener: () => void,
): () => void {
  let set = listeners.get(documentPath);
  if (!set) {
    set = new Set();
    listeners.set(documentPath, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(documentPath);
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
export function requestPromptBlobFocus(documentPath: string): void {
  pendingFocus.add(documentPath);
  for (const listener of focusListeners.get(documentPath) ?? []) listener();
}

/** One-shot: true (and clears the request) if a focus request is pending. */
export function consumePendingPromptBlobFocus(documentPath: string): boolean {
  return pendingFocus.delete(documentPath);
}

export function subscribePromptBlobFocus(
  documentPath: string,
  listener: () => void,
): () => void {
  let set = focusListeners.get(documentPath);
  if (!set) {
    set = new Set();
    focusListeners.set(documentPath, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) focusListeners.delete(documentPath);
  };
}
