/**
 * The add/edit/remove-link modal flow, shared by the toolbar link button
 * and the link bubble menu's Edit action.
 */

import type { Editor } from "@tiptap/core";
import { promptText } from "@/utils/fs";
import {
  normalizeLinkInput,
  isExternalUrl,
  decodeHrefForDisplay,
} from "./tiptap-link-utils";

export function useLinkPrompt(editor: Editor): () => Promise<void> {
  return async function handleLinkToggle() {
    const previousUrl = editor.getAttributes("link").href as string | undefined;
    // Internal hrefs are percent-encoded on disk (tiptap-link-utils.ts) —
    // prefill the prompt with the readable decoded form, but keep the raw
    // value so confirming unedited doesn't resave the decoded (unencoded)
    // text and silently reintroduce the space/angle-bracket bug it fixed.
    const previousDisplayUrl =
      previousUrl && !isExternalUrl(previousUrl)
        ? decodeHrefForDisplay(previousUrl)
        : previousUrl;

    const url = await promptText({
      title: previousUrl ? "Edit link" : "Add link",
      message: previousUrl ? "Clear the URL to remove the link." : undefined,
      defaultValue: previousDisplayUrl ?? "",
      placeholder: "https://example.com",
      confirmLabel: previousUrl ? "Save" : "Add link",
    });
    if (url === null) return;
    if (url === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    const href =
      url === previousDisplayUrl && previousUrl
        ? previousUrl
        : normalizeLinkInput(url);
    editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
  };
}
