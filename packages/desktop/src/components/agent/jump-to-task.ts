/**
 * "Jump" from a session listed outside the document (the sidebar's agent
 * runs) to where the user should look: the prompt widget in the document
 * that raised the round, when one is known — the widget already renders
 * the permission and sign-in cards, so answering happens in place — and
 * the session's chat tab otherwise (a chat-tab-originated turn, or a
 * document nobody has opened since launch).
 */
import { findPromptBlobForTask } from "@notefig/widgets";
import { jumpToBlob } from "@/components/editor/blobs/jump-to-blob";

export type JumpTarget = "widget" | "chat";

/** Where a jump for the task would land. */
export function jumpTargetForTask(
  taskId: string,
  turnId?: string | null,
): JumpTarget {
  return findPromptBlobForTask(taskId, turnId) ? "widget" : "chat";
}

/** The document a jump would reveal, for labelling the row. */
export function jumpDocumentForTask(
  taskId: string,
  turnId?: string | null,
): string | null {
  return findPromptBlobForTask(taskId, turnId)?.documentPath ?? null;
}

export function jumpToTask(
  taskId: string,
  options: { turnId?: string | null; openAgentTab: (taskId: string) => void },
): JumpTarget {
  const widget = findPromptBlobForTask(taskId, options.turnId);
  if (widget) {
    jumpToBlob(widget.documentPath, widget.blobId);
    return "widget";
  }
  options.openAgentTab(taskId);
  return "chat";
}
