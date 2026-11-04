import { describe, it, expect, afterEach } from "vitest";
import { Editor, Extension, Node } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import CodeBlock from "@tiptap/extension-code-block";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, TextSelection, type Transaction } from "@tiptap/pm/state";
import { indexedNodes, NodeIndex, type IndexedNode } from "../node-index";

let editor: Editor | null = null;
afterEach(() => editor?.destroy());

/** A block holding blocks: an indexed node can hold another. */
const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  indexed: true,
  parseHTML: () => [{ tag: "aside" }],
  renderHTML: () => ["aside", 0],
});

/** A textblock, indexed. */
const IndexedCodeBlock = CodeBlock.extend({ indexed: true });

function indexed(content: string, extra: Extension[] = []): Editor {
  editor = new Editor({
    extensions: [StarterKit.configure({ codeBlock: false }), IndexedCodeBlock, Callout, NodeIndex, ...extra],
    content,
  });
  return editor;
}

/** What a walk of the whole document finds. */
function walk(doc: PMNode, type: string): IndexedNode[] {
  const found: IndexedNode[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === type) found.push({ pos, node });
  });
  return found;
}

function expectMatchesWalk(target: Editor) {
  for (const type of ["callout", "codeBlock"]) {
    const index = indexedNodes(target.state, type);
    const expected = walk(target.state.doc, type);
    expect(index.map(({ pos }) => pos)).toEqual(expected.map(({ pos }) => pos));
    // The same node, not one an edit replaced.
    index.forEach((entry, i) => expect(entry.node).toBe(expected[i].node));
  }
}

/** A seeded random number generator, so a failure replays. */
function random(seed: number) {
  return () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
}

/** One random edit: text, deletes, blocks in and out, wraps, lifts, type
 *  and attribute changes, marks, a whole-document replace. */
function randomEdit(target: Editor, next: () => number): Transaction | null {
  const { state } = target;
  const { schema, doc } = state;
  const at = (max = doc.content.size) => Math.floor(next() * (max + 1));
  const tr = state.tr;
  const near = (pos: number) => TextSelection.near(doc.resolve(pos)).from;
  switch (Math.floor(next() * 9)) {
    case 0:
      return tr.insertText("typed", near(at()));
    case 1: {
      const from = at();
      return tr.delete(from, Math.min(doc.content.size, from + Math.floor(next() * 12)));
    }
    case 2:
      return tr.replaceSelectionWith(schema.nodes.codeBlock.create(null, schema.text("code"))).setSelection(
        TextSelection.near(tr.doc.resolve(near(at()))),
      );
    case 3: {
      const callout = schema.nodes.callout.create(null, schema.nodes.paragraph.create(null, schema.text("inside")));
      return tr.insert(doc.resolve(near(at())).after(1), callout);
    }
    case 4: {
      const $from = doc.resolve(near(at()));
      const range = $from.blockRange();
      return range ? tr.wrap(range, [{ type: schema.nodes.blockquote }]) : null;
    }
    case 5: {
      const pos = near(at());
      return tr.setBlockType(pos, pos, next() < 0.5 ? schema.nodes.codeBlock : schema.nodes.paragraph);
    }
    case 6: {
      const blocks = walk(doc, "codeBlock");
      if (blocks.length === 0) return null;
      const { pos } = blocks[Math.floor(next() * blocks.length)];
      return tr.setNodeAttribute(pos, "language", next() < 0.5 ? "ts" : null);
    }
    case 7: {
      const from = at();
      return tr.addMark(from, Math.min(doc.content.size, from + 8), schema.marks.bold.create());
    }
    default:
      // Several steps in one transaction.
      tr.insertText("a", near(at()));
      const [from, to] = [at(tr.doc.content.size), at(tr.doc.content.size)].sort((a, b) => a - b);
      tr.delete(from, to);
      return tr.insert(0, schema.nodes.paragraph.create(null, schema.text("top")));
  }
}

describe("node index", () => {
  it("lists the indexed nodes of the document it starts with", () => {
    const target = indexed(
      "<p>one</p><pre><code>a</code></pre><aside><p>x</p><pre><code>b</code></pre></aside>",
    );
    expect(indexedNodes(target.state, "codeBlock")).toHaveLength(2);
    expect(indexedNodes(target.state, "callout")).toHaveLength(1);
    expectMatchesWalk(target);
  });

  it("lists what a walk finds after every one of many random edits", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const next = random(seed);
      const target = indexed(
        "<p>one</p><pre><code>first</code></pre><aside><p>x</p><pre><code>b</code></pre></aside><p>two</p><ul><li><p>item</p></li></ul>",
      );
      for (let step = 0; step < 60; step++) {
        let tr: Transaction | null = null;
        try {
          tr = randomEdit(target, next);
        } catch {
          // A random range ProseMirror won't replace: no edit this time.
        }
        if (tr) target.view.dispatch(tr);
        expectMatchesWalk(target);
      }
      target.destroy();
    }
  });

  it("is up to date in another plugin's apply", () => {
    const seen: number[] = [];
    const reader = Extension.create({
      name: "reader",
      addProseMirrorPlugins: () => [
        new Plugin({
          state: {
            init: () => null,
            apply: (_tr, value, _old, state) => {
              seen.push(indexedNodes(state, "codeBlock").length);
              return value;
            },
          },
        }),
      ],
    });
    const target = indexed("<p>one</p>", [reader]);
    target.commands.insertContentAt(0, "<pre><code>a</code></pre>");
    expect(seen.at(-1)).toBe(1);
  });
});
