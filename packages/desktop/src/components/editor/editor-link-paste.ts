/**
 * Link paste handling for the markdown editor: pasting a URL over selected
 * text turns the selection into a link with the URL as its href.
 */

import type { EditorView } from "@tiptap/pm/view";
import { isExternalUrl } from "./tiptap-link-utils";

/** editorProps.handlePaste for text URLs pasted over a non-empty selection. */
export function createLinkPasteHandler() {
  return function handlePaste(
    view: EditorView,
    event: ClipboardEvent,
  ): boolean {
    const text = event.clipboardData?.getData("text/plain").trim();
    if (!text || !isExternalUrl(text)) return false;

    const { state } = view;
    const { selection } = state;
    if (selection.empty) return false;

    event.preventDefault();

    const linkMark = state.schema.marks.link.create({ href: text });
    view.dispatch(state.tr.addMark(selection.from, selection.to, linkMark));

    return true;
  };
}
