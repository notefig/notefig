/**
 * Pure markdown → HTML rendering for chat/LLM output. No editor, no DOM:
 * callable from the main thread and the conversion worker alike (the codec
 * shape — see blob-codec.ts / markdown-codec.ts).
 */

import MarkdownIt from "markdown-it";

// html: false keeps raw HTML in model output escaped (rendered as text), so
// no sanitizer pass is needed; breaks matches the chat's old pre-wrap feel
// where a single newline was a visible line break.
const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

export function renderMarkdownHtml(text: string): string {
  return md.render(text);
}
