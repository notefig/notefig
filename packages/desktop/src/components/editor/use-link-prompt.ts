/**
 * The add/edit/remove-link modal flow, shared by the toolbar link button
 * and the link bubble menu's Edit action.
 */

import type { Editor } from "@tiptap/core";
import { normalizeLinkInput } from "./tiptap-link-utils";
import { useCore } from "@notefig/core/react";

export function useLinkPrompt(editor: Editor): () => Promise<void> {
  const { platform } = useCore();
  return async function handleLinkToggle() {
    const previousUrl = editor.getAttributes("link").href as string | undefined;
    const url = await platform.ui.promptText({
      title: previousUrl ? "Edit link" : "Add link",
      message: previousUrl ? "Clear the URL to remove the link." : undefined,
      defaultValue: previousUrl ?? "",
      placeholder: "https://example.com",
      confirmLabel: previousUrl ? "Save" : "Add link",
    });
    if (url === null) return;
    if (url === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    const resolved = normalizeLinkInput(url);
    editor
      .chain()
      .focus()
      .extendMarkRange("link")
      .setLink({ href: resolved })
      .run();
  };
}
