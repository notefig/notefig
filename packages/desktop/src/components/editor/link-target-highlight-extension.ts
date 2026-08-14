/**
 * Renderer-only decoration (no schema/markdown impact — not part of
 * editor-schema-kit.ts): keeps a visible highlight over the text a picker is
 * about to link. Opening the file-link Popover moves DOM focus into its
 * search input, and ProseMirror's native selection highlight disappears
 * once the editor itself is no longer focused — this redraws it explicitly
 * so the user never loses sight of what they're linking.
 */
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export interface LinkTargetHighlightRange {
  from: number;
  to: number;
}

const linkTargetHighlightKey = new PluginKey<DecorationSet>(
  "linkTargetHighlight",
);

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    linkTargetHighlight: {
      showLinkTargetHighlight: (range: LinkTargetHighlightRange) => ReturnType;
      hideLinkTargetHighlight: () => ReturnType;
    };
  }
}

export const LinkTargetHighlight = Extension.create({
  name: "linkTargetHighlight",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: linkTargetHighlightKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, value) {
            const meta = tr.getMeta(linkTargetHighlightKey) as
              | LinkTargetHighlightRange
              | "clear"
              | undefined;
            if (meta === "clear") return DecorationSet.empty;
            if (meta) {
              return DecorationSet.create(tr.doc, [
                Decoration.inline(meta.from, meta.to, {
                  class: "file-link-target-highlight",
                }),
              ]);
            }
            return value.map(tr.mapping, tr.doc);
          },
        },
        props: {
          decorations(state) {
            return linkTargetHighlightKey.getState(state);
          },
        },
      }),
    ];
  },

  addCommands() {
    return {
      showLinkTargetHighlight:
        (range) =>
        ({ tr, dispatch }) => {
          if (dispatch) tr.setMeta(linkTargetHighlightKey, range);
          return true;
        },
      hideLinkTargetHighlight:
        () =>
        ({ tr, dispatch }) => {
          if (dispatch) tr.setMeta(linkTargetHighlightKey, "clear");
          return true;
        },
    };
  },
});
