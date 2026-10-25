/**
 * "Jump" from a session listed outside the document (the sidebar's agent
 * runs) to where the user should look: the prompt widget in the document
 * that raised the round, when one is known — the widget already renders
 * the permission and sign-in cards, so answering happens in place — and
 * the session's chat tab otherwise (a chat-tab-originated turn, or a
 * document nobody has opened since launch).
 */
import type { PromptWidgetsApi } from "@notefig/widgets";
import type { PromptRound } from "@/modules/prompt-rounds";
import type { Core } from "@notefig/core";

export type JumpTarget = "widget" | "chat";

/** What a jump drives: the tabs, which also reveal a widget in its
 *  document, and the prompt widgets, which say where a round's widget is. */
export interface Jumper {
  tabs: Pick<Core["tabs"], "open" | "openAgent" | "reveal">;
  promptWidgets: Pick<PromptWidgetsApi, "findByTask">;
}

export function jumpToTask(
  core: Jumper,
  taskId: string,
  options: { turnId?: string | null } = {},
): JumpTarget {
  const widget = core.promptWidgets.findByTask(taskId, options.turnId);
  if (widget) {
    revealWidget(core, widget);
    return "widget";
  }
  core.tabs.openAgent(taskId);
  return "chat";
}

/**
 * Jump to a prompt round: the widget itself when it is mounted this run
 * and still bound to the round, else its document.
 */
export function jumpToRound(
  core: Jumper,
  round: Pick<PromptRound, "taskId" | "turnId" | "documentPath">,
): void {
  const widget = core.promptWidgets.findByTask(round.taskId, round.turnId);
  if (widget && widget.boundTurnId === round.turnId) {
    revealWidget(core, widget);
  } else {
    core.tabs.open(round.documentPath, { intent: "replace" });
  }
}

/** Focus (opening if need be) the widget's document and scroll the widget
 *  into view: it is found by the `data-blob-id` its node view sets. */
function revealWidget(
  core: Jumper,
  widget: { documentPath: string; blobId: string },
): void {
  void core.tabs.reveal(
    widget.documentPath,
    { blockId: widget.blobId },
    { intent: "new-tab", moveIfOpen: true },
  );
}
