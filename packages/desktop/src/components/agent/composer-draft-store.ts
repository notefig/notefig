/**
 * Per-session composer drafts, outside React — the dock mounts only the
 * selected tab, so a chat tab's component state dies on every tab switch.
 * Same module-level-Map pattern as the editor registry in editor-store.ts.
 * Ephemeral by design (like the agent collections); task ids never recur,
 * so no cleanup sweep is needed.
 */
const drafts = new Map<string, string>();

export function getComposerDraft(taskId: string): string {
  return drafts.get(taskId) ?? "";
}

export function setComposerDraft(taskId: string, draft: string): void {
  if (draft) drafts.set(taskId, draft);
  else drafts.delete(taskId);
}

export function clearComposerDraft(taskId: string): void {
  drafts.delete(taskId);
}
