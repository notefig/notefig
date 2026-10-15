/**
 * Page links (MET-78): typing "@" in ordinary document prose opens the same
 * workspace-file popup the prompt drafts use, and picking a file inserts a
 * link to that page instead of a mention chip.
 *
 * Lives in this package so the whole "@" family — the chip, the popup, the
 * mention-bridge seam, and this — stays one mechanism; the file search
 * already rides the mention service the document's `PromptMentionMenu`
 * registers, since only one caret exists. Link policy stays the
 * application's: what an href should look like arrives as `buildHref` — the
 * finished decision, not path utilities — so this package never learns path
 * math or resolver conventions.
 *
 * A second Suggestion registration rather than a widening of the widget's
 * own: the draft-scoped one belongs to the prompt widget (its `allow` is
 * the scoping). The two `allow` guards are exact complements — inside a
 * draft the widget's plugin owns "@", everywhere else this one does. A
 * distinct plugin key keeps ProseMirror from rejecting the second instance
 * (the widget's uses Suggestion's default).
 */
import { Extension } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import Suggestion from "@tiptap/suggestion";
import { documentMenu, getMentionService } from "./prompt/composer/mention-bridge";
import { mentionSuggestion, type MentionRow } from "./prompt/composer/mention-suggestion";
import { selectionDraft } from "./prompt/doc-helpers";

/** Link text: the file name, with a page's ".md" dropped — the link names
 *  the page, the href keeps the real file. */
export function pageLinkLabel(title: string): string {
  const stripped = title.replace(/\.md$/i, "");
  return stripped || title;
}

const pageLinkPluginKey = new PluginKey("pageLinkSuggestion");

export interface PageLinkSuggestionOptions {
  /** The document this editor holds — the mention-service registry key. */
  documentPath: string;
  /** The application's href policy: the link target written into the
   *  document for a picked file's workspace-relative path. */
  buildHref: (relativePath: string) => string;
}

export const PageLinkSuggestion = Extension.create<PageLinkSuggestionOptions>({
  name: "pageLinkSuggestion",

  addOptions() {
    return { documentPath: "", buildHref: (relativePath) => relativePath };
  },

  addProseMirrorPlugins() {
    const { documentPath, buildHref } = this.options;
    // Unconfigured instances (a shared kit, the worker) contribute nothing.
    if (!documentPath) return [];
    return [
      Suggestion<MentionRow, MentionRow>({
        pluginKey: pageLinkPluginKey,
        editor: this.editor,
        allow: ({ state, range }) => {
          const $from = state.doc.resolve(range.from);
          // Code blocks (and any other markless textblock) take no link.
          if (!$from.parent.type.allowsMarkType(state.schema.marks.link)) {
            return false;
          }
          // Inside a draft the widget's own suggestion owns "@".
          return !selectionDraft({ selection: { $from } });
        },
        ...mentionSuggestion({
          // Files only: a directive means nothing in the document's prose.
          search: (query) =>
            getMentionService(documentPath)?.search(query, { directives: false }) ?? [],
          // A link, not a chip; and a file only.
          insert: (editor, range, row) => {
            if (row.kind !== "file") return;
            const { relativePath: id, title: label } = row.file;
            editor
              .chain()
              .focus()
              .insertContentAt(range, [
                {
                  type: "text",
                  text: pageLinkLabel(label),
                  marks: [{ type: "link", attrs: { href: buildHref(id) } }],
                },
                // Unmarked, so typing on lands outside the link.
                { type: "text", text: " " },
              ])
              .run();
          },
          render: documentMenu(documentPath),
        }),
      }),
    ];
  },
});
