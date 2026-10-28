/**
 * Diff blocks through markdown-it, whose fence renderer keeps only an info
 * string's first word, the language. Worker-safe: no DOM.
 */
import type MarkdownIt from "markdown-it";
import { DIFF_BLOCK_TAG, DIFF_DATA_ATTRIBUTE, diffOfInfo } from "./syntax";

/** Keeps a fence's diff on its `<code>`, where the editor's parse reads it
 *  (./schema.ts). */
export function diffFences(md: MarkdownIt): void {
  md.core.ruler.push("diff_fences", (state) => {
    for (const token of state.tokens) {
      if (token.type !== "fence") continue;
      const diff = diffOfInfo(token.info);
      if (diff !== null) token.attrSet(DIFF_DATA_ATTRIBUTE, diff);
    }
  });
}

/**
 * Also wraps each diff fence in the element that draws it (./element.ts),
 * for HTML that is shown as it is: chat, widget responses. Its text is the
 * block's as the editor holds it, without the newline markdown-it ends
 * every fence with.
 */
export function drawnDiffFences(md: MarkdownIt): void {
  md.use(diffFences);
  const fence = md.renderer.rules.fence!;
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const html = fence(tokens, idx, options, env, self);
    if (tokens[idx].attrGet(DIFF_DATA_ATTRIBUTE) === null) return html;
    const pre = html.replace(/\n<\/code><\/pre>\n$/, "</code></pre>");
    return `<${DIFF_BLOCK_TAG}>${pre}</${DIFF_BLOCK_TAG}>\n`;
  };
}
