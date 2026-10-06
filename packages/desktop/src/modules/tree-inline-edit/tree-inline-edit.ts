import { FILE_TREE_TAG_NAME } from "@pierre/trees";
import { defineModule } from "@notefig/core";

/**
 * The file tree's inline text entry — the rename field, and the name field
 * "New file" opens — ends when it loses focus, and @pierre/trees re-focuses
 * the row it was editing as part of that commit.
 *
 * That is right when the entry was ended from inside the tree (Enter, or a
 * press on another row): the user is in the tree, so the tree keeps focus.
 * It is wrong when the entry was ended by a press OUTSIDE the tree — into a
 * document, a toolbar, another panel. The browser dispatches blur BEFORE it
 * moves focus to what was pressed, so the tree's re-focus lands last and
 * the tree ends up holding focus: the user's press does nothing, and what
 * they type next goes wherever the tree left the caret.
 *
 * Ending the entry on the way down puts the order back: the commit and the
 * tree's own row re-focus both run while the press is still being
 * dispatched, and the browser then focuses what was actually pressed, as it
 * does everywhere else in the app.
 *
 * One listener for the whole app, installed at boot — not a component
 * effect, and not one per tree. There is no per-tree state to hold: only a
 * tree that HAS focus can have an open entry, and `document.activeElement`
 * names it, because focus inside a shadow root reports the host. A window
 * with three workspace trees open still needs exactly this one listener.
 */
/** The attribute @pierre/trees puts on the inline entry's input. */
const INLINE_EDIT_INPUT = "[data-item-rename-input]";

/** The inline entry that currently holds focus, in whichever tree owns it. */
function focusedInlineEdit(): { host: HTMLElement; input: HTMLElement } | null {
  const host = document.activeElement;
  if (!(host instanceof HTMLElement)) return null;
  if (host.localName !== FILE_TREE_TAG_NAME) return null;
  const input = host.shadowRoot?.activeElement;
  if (!(input instanceof HTMLElement) || !input.matches(INLINE_EDIT_INPUT)) {
    return null;
  }
  return { host, input };
}

/** Start dismissing tree inline edits on presses outside their tree. */
export function startTreeInlineEditDismissal(): () => void {
  const onPress = (event: MouseEvent) => {
    const edit = focusedInlineEdit();
    if (!edit || event.composedPath().includes(edit.host)) return;
    edit.input.blur();
  };
  document.addEventListener("mousedown", onPress, true);
  return () => document.removeEventListener("mousedown", onPress, true);
}

/** Dismisses an inline tree edit on an outside press. */
export const treeInlineEditModule = defineModule({
  name: "tree-inline-edit",
  boot: () => startTreeInlineEditDismissal(),
});
