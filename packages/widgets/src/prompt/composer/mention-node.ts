/**
 * The "@" file mention, as a node of the host document.
 *
 * It used to live only in the composer's throwaway schema, so it never met
 * the markdown codec. Now that the draft is document content the mention
 * node is part of the document schema too, and two things follow:
 *
 *  - the conversion worker must build the same node (registry.ts ships it
 *    with the widget's other schema halves), or a parse in the worker and a
 *    parse in the editor disagree;
 *  - it needs a markdown serializer. A mention can only ever be created
 *    inside a draft, which never serializes — but a paste can put one
 *    anywhere, and without a serializer tiptap-markdown's HTML fallback
 *    would write a `<span data-type="mention">` into the user's file. It
 *    writes the same `@<relativePath>` text the chip stands for, which is
 *    exactly what the submit paths re-parse (see prompt-editor.ts's mention
 *    text contract).
 *
 * The suggestion half is renderer-only: `promptMentionNode()` with no
 * argument is the worker-safe base, and with one it is the live editor's.
 * `configure()` replaces options wholesale, so everything is re-specified
 * on each call rather than layered.
 */
import { mergeAttributes } from "@tiptap/core";
import Mention from "@tiptap/extension-mention";
import type { SuggestionOptions } from "@tiptap/suggestion";

export const PROMPT_MENTION_NAME = "mention";

const MentionWithMarkdown = Mention.extend({
  addStorage() {
    return {
      markdown: {
        serialize(
          state: { write: (s: string) => void },
          node: { attrs: { id: string | null } },
        ) {
          state.write(`@${node.attrs.id ?? ""}`);
        },
      },
    };
  },
});

export function promptMentionNode(
  suggestion?: Partial<SuggestionOptions>,
) {
  return MentionWithMarkdown.configure({
    deleteTriggerWithBackspace: true,
    // Muted chip background so mentions read as attachments — rendering
    // only; the serialized draft stays the literal @path text.
    HTMLAttributes: {
      class: "rounded-sm bg-muted px-1 whitespace-nowrap",
    },
    renderHTML: ({ options, node }) => [
      "span",
      mergeAttributes(options.HTMLAttributes, {
        "data-type": "mention",
        "data-id": node.attrs.id,
      }),
      `@${node.attrs.label ?? node.attrs.id}`,
    ],
    ...(suggestion ? { suggestion } : {}),
  });
}
