/**
 * How a round's changes look in the document: an underline in the widget's
 * colour under what the round wrote, a thin bar where it only deleted. The
 * hover names the prompt that made the change.
 *
 * Purely a view of `promptChangesOf(state)` — swapping this module for a
 * gutter, a margin list or a diff overlay touches nothing in the tracking.
 */
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { promptChangesOf } from "./change-tracking";
import { promptChangeColor, type PromptChange } from "./change-store";
import { getPromptBlob } from "./store";

const decorationKey = new PluginKey("promptChangeDecorations");

function changeStyle(blobId: string): string {
  return `--prompt-change: ${promptChangeColor(blobId)}; --prompt-change-bg: ${promptChangeColor(blobId, 0.12)}`;
}

function changeTitle(blobId: string): string | undefined {
  const prompt = getPromptBlob(blobId).lastSentPrompt.trim().split("\n", 1)[0];
  return prompt || undefined;
}

function deletionMarker(change: PromptChange): HTMLElement {
  const marker = document.createElement("span");
  marker.className =
    "prompt-change-deletion inline-block h-[1em] w-0.5 rounded-full align-text-bottom bg-(--prompt-change)";
  marker.setAttribute("style", changeStyle(change.blobId));
  marker.dataset.promptChange = change.blobId;
  const title = changeTitle(change.blobId);
  if (title) marker.title = title;
  return marker;
}

export function buildPromptChangeDecorations(
  state: EditorState,
): DecorationSet {
  const changes = promptChangesOf(state);
  if (changes.length === 0) return DecorationSet.empty;
  const decorations = changes.map((change) => {
    if (change.from === change.to) {
      return Decoration.widget(change.from, () => deletionMarker(change), {
        key: `prompt-change-${change.blobId}-${change.from}`,
        side: -1,
        ignoreSelection: true,
      });
    }
    const title = changeTitle(change.blobId);
    return Decoration.inline(change.from, change.to, {
      class:
        "prompt-change rounded-[2px] bg-(--prompt-change-bg) underline decoration-(--prompt-change) decoration-2 underline-offset-4",
      style: changeStyle(change.blobId),
      "data-prompt-change": change.blobId,
      ...(title ? { title } : {}),
    });
  });
  return DecorationSet.create(state.doc, decorations);
}

export function promptChangeDecorationsPlugin(): Plugin {
  // One DecorationSet per changes array: `decorations` runs on every view
  // update, the changes only move when the document does.
  const cache = new WeakMap<readonly PromptChange[], DecorationSet>();
  return new Plugin({
    key: decorationKey,
    props: {
      decorations(state) {
        const changes = promptChangesOf(state);
        let set = cache.get(changes);
        if (!set) {
          set = buildPromptChangeDecorations(state);
          cache.set(changes, set);
        }
        return set;
      },
    },
  });
}
