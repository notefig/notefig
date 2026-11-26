/**
 * Pure markdown → HTML rendering for chat/LLM output. No editor, no DOM:
 * callable from the main thread and the conversion worker alike (the codec
 * shape — see blob-codec.ts / markdown-codec.ts).
 */

import MarkdownIt from "markdown-it";
import { drawnDiffFences } from "@notefig/widgets/diff-block/markdown";
import { drawnMermaidFences } from "@notefig/widgets/mermaid-block/markdown";
import { isDiffInfo } from "@notefig/widgets/diff-block/syntax";
import { isMermaidInfo } from "@notefig/widgets/mermaid-block/syntax";

// html: false keeps raw HTML in model output escaped (rendered as text), so
// no sanitizer pass is needed; breaks matches the chat's old pre-wrap feel
// where a single newline was a visible line break. A diff fence, and a
// mermaid one, comes out as the element that draws it.
const md = new MarkdownIt({ html: false, linkify: true, breaks: true }).use(drawnDiffFences).use(drawnMermaidFences);

// linkify-it with fuzzyLink enabled treats local file references such as
// "2026-10-23.md" as .md (Moldova) domains and turns them into external
// http://2026-10-23.md links. Keep linkification for explicit schemes
// (https://...) but disable schemaless/fuzzy URLs in LLM output.
md.linkify.set({ fuzzyLink: false });

export function renderMarkdownHtml(text: string): string {
  return md.render(text);
}

/**
 * Inline-only rendering: no wrapping <p>, so a fragment (one bullet's text,
 * a heading) can be dropped straight into an existing element. Same `html:
 * false` renderer, so raw HTML stays escaped here too.
 */
export function renderMarkdownInline(text: string): string {
  return md.renderInline(text);
}

/**
 * The first block `text` would draw as a card, a diff or a diagram: read as
 * this renderer reads it, so a fence in a quote or a list counts, and an
 * indented example, or prose naming the syntax, does not.
 */
export function drawnBlockIn(text: string): "diff" | "mermaid" | null {
  for (const token of md.parse(text, {})) {
    if (token.type !== "fence") continue;
    if (isDiffInfo(token.info)) return "diff";
    if (isMermaidInfo(token.info)) return "mermaid";
  }
  return null;
}
