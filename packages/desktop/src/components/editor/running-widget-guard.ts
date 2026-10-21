/**
 * A prompt widget whose agent is still working stays on the page (MET-248).
 *
 * The widget is the only handle on its session: deleting it mid-turn (a
 * selection delete, a cut, an undo past its insertion) leaves the agent
 * running with nowhere to report, and putting it back unbinds it. So any
 * edit that would remove a widget whose task has a turn queued or running
 * is refused; once the turn settles the widget is ordinary content again.
 *
 * The guard knows nothing about the widget's UI. It reads the session off
 * the node (`taskId`, written at send time) and asks the caller whether
 * that task is busy, at the moment of the edit. Adoption is let through:
 * it re-asserts dropped widgets itself (adopt-external-content.ts).
 */
import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import { PROMPT_NODE_NAME } from "@notefig/widgets";
import { ADOPTION_TRANSACTION_META } from "./adopt-external-content";

export type IsTaskBusy = (taskId: string) => boolean;

/** Session ids of the prompt widgets in `doc`. */
function widgetTaskIds(doc: PMNode): Set<string> {
  const ids = new Set<string>();
  doc.descendants((node) => {
    if (node.type.name === PROMPT_NODE_NAME) {
      const taskId = node.attrs.taskId as string | null;
      if (taskId) ids.add(taskId);
      return false;
    }
    return !node.isTextblock;
  });
  return ids;
}

export function runningWidgetGuard(isTaskBusy: IsTaskBusy) {
  return Extension.create({
    name: "runningWidgetGuard",
    addProseMirrorPlugins() {
      return [
        new Plugin({
          filterTransaction(tr, state) {
            if (!tr.docChanged || tr.getMeta(ADOPTION_TRANSACTION_META)) {
              return true;
            }
            const busy = [...widgetTaskIds(state.doc)].filter(isTaskBusy);
            if (busy.length === 0) return true;
            const kept = widgetTaskIds(tr.doc);
            return busy.every((taskId) => kept.has(taskId));
          },
        }),
      ];
    },
  });
}
