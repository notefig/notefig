/**
 * Mermaid blocks through markdown-it, for HTML that is shown as it is:
 * chat, widget responses. Worker-safe: no DOM.
 */
import type MarkdownIt from "markdown-it";
import { isMermaidInfo, MERMAID_BLOCK_TAG } from "./syntax";

/**
 * Wraps each mermaid fence in the element that draws it (./element.tsx).
 * Its text is the block's as the editor holds it, without the newline
 * markdown-it ends every fence with.
 */
export function drawnMermaidFences(md: MarkdownIt): void {
  const fence = md.renderer.rules.fence!;
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const html = fence(tokens, idx, options, env, self);
    if (!isMermaidInfo(tokens[idx].info)) return html;
    const pre = html.replace(/\n<\/code><\/pre>\n$/, "</code></pre>");
    return `<${MERMAID_BLOCK_TAG}>${pre}</${MERMAID_BLOCK_TAG}>\n`;
  };
}
