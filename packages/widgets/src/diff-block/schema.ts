/**
 * The code block, with its diff (./syntax.ts) an attribute beside its
 * language: null for plain code, "" for a diff of no named file, else the
 * file's path. Worker-safe: the markdown codec builds its schema from this.
 */
import CodeBlock from "@tiptap/extension-code-block";
import type { Node as PMNode } from "@tiptap/pm/model";
import type MarkdownIt from "markdown-it";
import { diffFences } from "./markdown";
import { DIFF_DATA_ATTRIBUTE, diffInfo } from "./syntax";

interface MarkdownState {
  write(text: string): void;
  text(text: string, escape: boolean): void;
  ensureNewLine(): void;
  closeBlock(node: PMNode): void;
}

export const DiffCodeBlock = CodeBlock.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      diff: {
        default: null,
        parseHTML: (pre: HTMLElement) =>
          pre.getAttribute(DIFF_DATA_ATTRIBUTE) ?? pre.querySelector("code")?.getAttribute(DIFF_DATA_ATTRIBUTE) ?? null,
        renderHTML: ({ diff }: { diff: string | null }) => (diff === null ? {} : { [DIFF_DATA_ATTRIBUTE]: diff }),
      },
    };
  },

  // tiptap-markdown's code block spec, with the diff after the language: a
  // spec replaces its default whole, `parse` included.
  addStorage() {
    return {
      markdown: {
        serialize(state: MarkdownState, node: PMNode) {
          const { language, diff } = node.attrs as { language: string | null; diff: string | null };
          // A diff needs a language before it: a lone ```diff is that language.
          state.write("```" + (language || (diff === null ? "" : "text")) + diffInfo(diff) + "\n");
          state.text(node.textContent, false);
          state.ensureNewLine();
          state.write("```");
          state.closeBlock(node);
        },
        parse: {
          setup(this: { options: { languageClassPrefix?: string | null } }, md: MarkdownIt) {
            md.set({ langPrefix: this.options.languageClassPrefix ?? "language-" });
            md.use(diffFences);
          },
          updateDOM(element: HTMLElement) {
            element.innerHTML = element.innerHTML.replace(/\n<\/code><\/pre>/g, "</code></pre>");
          },
        },
      },
    };
  },
});
