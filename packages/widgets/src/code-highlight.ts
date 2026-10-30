/**
 * Code blocks in documents, highlighted by the code viewer's own Shiki —
 * `@pierre/diffs`' shared highlighter — with Pierre's light and dark themes.
 * Each token carries both themes' colours (`color`, `--shiki-dark`); the
 * stylesheet shows the dark one under `.dark`, so switching theme
 * re-tokenizes nothing. A language loads in the background, and its blocks
 * are coloured when it lands; one Shiki doesn't know stays plain.
 */
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { getHighlighterIfLoaded, getSharedHighlighter } from "@pierre/diffs";

const THEMES = { light: "pierre-light", dark: "pierre-dark" } as const;
/** Past this a block stays plain: tokenizing it on every keystroke in it
 *  costs more than its colours are worth. */
const MAX_BLOCK_LENGTH = 20_000;
const key = new PluginKey<DecorationSet>("codeHighlight");

/** Each language asked for, and whether Shiki knew it. */
const loads = new Map<string, Promise<boolean>>();

type Token = [from: number, to: number, style: string];

/** A block's coloured tokens, offsets from its start; none until its
 *  language and both themes are loaded — the highlighter is shared, so
 *  another user may have loaded the language without them. */
function tokensOf(node: PMNode): Token[] {
  const lang = node.attrs.language as string | null;
  const highlighter = getHighlighterIfLoaded();
  if (!lang || !highlighter?.getLoadedLanguages().includes(lang)) return [];
  const themes = highlighter.getLoadedThemes();
  if (!Object.values(THEMES).every((theme) => themes.includes(theme))) return [];
  if (node.textContent.length > MAX_BLOCK_LENGTH) return [];
  return highlighter
    .codeToTokens(node.textContent, { lang, themes: THEMES })
    .tokens.flat()
    .filter(({ content, htmlStyle }) => content.trim() && htmlStyle)
    .map(({ content, offset, htmlStyle }) => [
      offset,
      offset + content.length,
      Object.entries(htmlStyle!)
        .map(([property, value]) => `${property}:${value}`)
        .join(";"),
    ]);
}

/** Walk `doc`'s code blocks, never into the text of any other block. */
function eachCodeBlock(
  doc: PMNode,
  visit: (node: PMNode, pos: number) => void,
): void {
  doc.descendants((node, pos) => {
    if (node.type.name === "codeBlock") visit(node, pos);
    else return !node.isTextblock;
    return false;
  });
}

/** Whether any step of `tr` changed a code block, or made one. A block
 *  it deleted whole needs nothing: mapping drops its decorations. */
function touchesCode(tr: Transaction): boolean {
  let touched = false;
  tr.mapping.maps.forEach((stepMap, index) => {
    const after = tr.mapping.slice(index + 1);
    stepMap.forEach((_oldFrom, _oldTo, newFrom, newTo) => {
      tr.doc.nodesBetween(after.map(newFrom, -1), after.map(newTo, 1), (node) => {
        if (node.type.name === "codeBlock") touched = true;
        return !touched && !node.isTextblock;
      });
    });
  });
  return touched;
}

export function codeHighlight(): Plugin {
  // An edit leaves every block it didn't touch the same node, so only the
  // ones it touched are tokenized again.
  let cache = new WeakMap<PMNode, Token[]>();
  const decorate = (doc: PMNode) => {
    const decorations: Decoration[] = [];
    eachCodeBlock(doc, (node, pos) => {
      let tokens = cache.get(node);
      if (!tokens) cache.set(node, (tokens = tokensOf(node)));
      for (const [from, to, style] of tokens) {
        decorations.push(Decoration.inline(pos + 1 + from, pos + 1 + to, { style }));
      }
    });
    return DecorationSet.create(doc, decorations);
  };

  return new Plugin({
    key,
    state: {
      init: (_config, { doc }) => decorate(doc),
      // An edit away from every code block (most typing) only moves the
      // colours along: walking the document for it cost ~5 ms a keystroke
      // in an 8,000-line one.
      apply: (tr, set) => {
        if (tr.getMeta(key) || (tr.docChanged && touchesCode(tr))) return decorate(tr.doc);
        return tr.docChanged ? set.map(tr.mapping, tr.doc) : set;
      },
    },
    props: { decorations: (state) => key.getState(state) },
    // Loads the languages the blocks name, then re-colours. Each view waits
    // on the shared load itself: one made while another's load was under way
    // must still hear when it lands.
    view(view) {
      const awaited = new Set<string>();
      let live = true;
      const load = () =>
        eachCodeBlock(view.state.doc, (node) => {
          const lang = node.attrs.language as string | null;
          if (lang && !awaited.has(lang)) {
            awaited.add(lang);
            if (!loads.has(lang)) {
              const themes = Object.values(THEMES);
              loads.set(lang, getSharedHighlighter({ themes, langs: [lang] }).then(() => true, () => false));
            }
            void loads.get(lang)!.then((known) => {
              if (!known || !live) return;
              cache = new WeakMap();
              view.dispatch(view.state.tr.setMeta(key, true).setMeta("addToHistory", false));
            });
          }
        });
      load();
      return {
        update: (_view, previous) => {
          if (view.state.doc !== previous.doc) load();
        },
        destroy: () => {
          live = false;
        },
      };
    },
  });
}
