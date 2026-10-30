/**
 * isActiveIn answers as `editor.isActive` does, for every format the
 * toolbar and the bubble menus ask about, over every range of a document
 * that has each of them (and code, whose blocks take no marks).
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, isActive } from "@tiptap/core";
import { TextSelection, type EditorState } from "@tiptap/pm/state";
import { createSchemaExtensions } from "../editor-schema-kit";
import { isActiveIn } from "../active-formats";

const QUESTIONS: [string, Record<string, unknown>?][] = [
  ["heading", { level: 1 }],
  ["heading", { level: 2 }],
  ["heading"],
  ["bold"],
  ["italic"],
  ["underline"],
  ["strike"],
  ["code"],
  ["link"],
  ["link", { href: "a.md" }],
  ["bulletList"],
  ["orderedList"],
  ["blockquote"],
  ["codeBlock"],
  ["table"],
  ["paragraph"],
];

const CONTENT =
  "<h1>Ti<strong>tle</strong></h1>" +
  "<p><strong>bold <em>both</em></strong><em> italic</em> <s>gone</s></p>" +
  "<p><a href='a.md'>link <strong>bold</strong></a><code>code</code></p>" +
  "<h2><strong>all bold</strong></h2>" +
  "<ul><li><p><strong>one</strong></p></li><li><p>two</p></li></ul>" +
  "<ol><li><p>three</p></li></ol>" +
  "<blockquote><p><em>quoted</em></p></blockquote>" +
  "<pre><code>const x = 1;</code></pre>" +
  "<table><tr><th><p>H</p></th></tr><tr><td><p><strong>C</strong></p></td></tr></table>";

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

/** The editor's state with every text selection its document allows. */
function* everyRange(state: EditorState): Generator<EditorState> {
  const { doc } = state;
  const inline: number[] = [];
  for (let pos = 0; pos <= doc.content.size; pos++)
    if (doc.resolve(pos).parent.inlineContent) inline.push(pos);
  for (const from of inline)
    for (const to of inline.filter((pos) => pos >= from))
      yield state.apply(
        state.tr.setSelection(TextSelection.create(doc, from, to)),
      );
}

/** Every question isActiveIn answers unlike Tiptap over `state`. */
function disagreements(state: EditorState): string[] {
  const { from, to } = state.selection;
  return QUESTIONS.filter(
    ([name, attrs]) =>
      isActiveIn(state, name, attrs) !== isActive(state, name, attrs ?? {}),
  ).map(
    ([name, attrs]) => `${name} ${JSON.stringify(attrs)} over ${from}-${to}`,
  );
}

describe("isActiveIn", () => {
  it("answers as Tiptap does over every range", () => {
    editor = new Editor({
      extensions: createSchemaExtensions(),
      content: CONTENT,
    });
    const states = [...everyRange(editor.state)];
    expect(states.flatMap(disagreements)).toEqual([]);
    // Enough ranges, and enough of them active, to tell the rules apart.
    expect(states.length).toBeGreaterThan(1000);
    const active = states.filter(
      (state) =>
        !state.selection.empty &&
        QUESTIONS.some(([name, attrs]) => isActive(state, name, attrs ?? {})),
    );
    expect(active.length).toBeGreaterThan(500);
  }, 30_000);

  it("answers as editor.isActive over the whole document", () => {
    editor = new Editor({
      extensions: createSchemaExtensions(),
      content: CONTENT,
    });
    editor.commands.selectAll();
    expect(disagreements(editor.state)).toEqual([]);
    editor.commands.setContent("<h2><strong>all bold</strong></h2>");
    editor.commands.selectAll();
    expect(disagreements(editor.state)).toEqual([]);
  });
});
