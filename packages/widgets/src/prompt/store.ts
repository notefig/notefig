/**
 * Per-WIDGET round state, outside React — keyed by the aiPrompt node's
 * `blobId` attr, NOT the document path: a document can hold several widgets
 * ("/" summons), and each watches its own turn.
 *
 * This is the widget's binding to an agent session, and nothing else. The
 * draft the user types is not here: it is content of the aiPrompt node
 * (`promptDraft`), which is what puts the composer inside the editor's own
 * lifecycle and is why the record survived losing its `draft` field.
 *
 * Lives outside React because the dock mounts only the selected tab, so
 * component state dies on every tab switch. A record is read while it
 * changes from outside the component (send rebinds the turn), so this store
 * adds a subscribe/emit for useSyncExternalStore. Ephemeral by design, like
 * the agent collections: nothing persists across app runs, ids never recur,
 * and a stale bound turn (rows gone) simply renders as composing again.
 */
export type PromptBlobRecord = {
  /** The turn this widget is watching, or null while composing. */
  boundTurnId: string | null;
  /** Task captured at send time — the shared session may rotate afterwards,
   *  but this widget stays on the task its turn ran on. */
  boundTaskId: string | null;
  /** Last sent prompt text, for the Edit affordance. */
  lastSentPrompt: string;
};

const EMPTY_RECORD: PromptBlobRecord = {
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

/**
 * Seed the binding a widget carried in the document (MET-163), so a widget
 * restored from the file renders as belonging to its session rather than as
 * a fresh composer.
 *
 * Never clobbers live state: during adoption (an agent writing this file
 * mid-round) the record still holds the running turn, and the re-parsed node
 * brings back the same ids it was serialized with.
 */
export function adoptPersistedPromptBinding(
  blobId: string,
  taskId: string,
): void {
  if (getPromptBlob(blobId).boundTaskId) return;
  updatePromptBlob(blobId, { boundTaskId: taskId });
}

/** Unbind the watched turn (dismiss / stale-row reset). The draft is
 *  untouched: it lives in the document, not here. */
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
