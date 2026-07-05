/**
 * Pins the markdown codec to the live editor's behavior: the codec (which
 * runs in the conversion worker) must produce byte-identical markdown and
 * structurally identical doc JSON, or saves through the worker would corrupt
 * files relative to what the editor shows.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import { editorExtensions } from "../tiptap-editor-kit";
import { createMarkdownCodec } from "../markdown-codec";
import { calculateContentHash } from "@/utils/hash";

const codec = createMarkdownCodec();

const editors: Editor[] = [];

function createEditor(content = ""): Editor {
  const editor = new Editor({
    extensions: editorExtensions,
    content,
    editable: true,
    autofocus: false,
  });
  editors.push(editor);
  return editor;
}

afterEach(() => {
  editors.forEach((e) => e.destroy());
  editors.length = 0;
});

function getMarkdown(editor: Editor): string {
  return (
    editor.storage as unknown as { markdown: { getMarkdown: () => string } }
  ).markdown.getMarkdown();
}

export const fixtures: string[] = [
  "Hello world",
  "First\n\nSecond",
  "# Heading",
  "###### Deep heading",
  "Some **bold** text",
  "Some *italic* text",
  "Some ***bold italic*** text",
  "Some ~~struck~~ text",
  "Some `code` text",
  "Visit [example](https://example.com) today",
  "> Quoted text",
  "Above\n\n---\n\nBelow",
  "- one\n- two\n- three",
  "- parent\n  - child\n  - child two",
  "1. one\n2. two\n3. three",
  "```ts\nconst x = 1;\n```",
  "```\nplain text\n```",
  "- [ ] todo",
  "- [x] done",
  "- [ ] first\n- [x] second\n- [ ] third",
  "- [ ] has **bold** content",
  "- [ ]",
  "- [x]",
  "- [ ] first\n- [ ]\n- [x] third",
  "- [ ] first\n\n- [x] second",
  "Some <u>underlined</u> text",
  "Some <mark>highlighted</mark> text",
  "H<sub>2</sub>O",
  "x<sup>2</sup>",
  "Before\n\n![alt text](assets/pic.png)\n\nAfter",
  "* one\n* two",
  "Some _italic_ text",
  "line one  \nline two",
  "Heading\n====",
  "| Name | Age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 25 |",
  "text before ![inline](pic.png) text after",
  "Before\n\n<div>raw html</div>\n\nAfter",
  "",
  [
    "# Title",
    "",
    "Intro with **bold**, *italic*, `code`, ~~strike~~ and a [link](https://example.com).",
    "",
    "## Lists",
    "",
    "- bullet one",
    "- bullet two",
    "  - nested",
    "",
    "1. ordered",
    "2. items",
    "",
    "- [ ] open task",
    "- [x] closed task",
    "",
    "Text with <u>underline</u> and <mark>highlight</mark> marks.",
    "",
    "![kitchen sink image](assets/sink.png)",
    "",
    "> A blockquote",
    "",
    "```js",
    "console.log('hi');",
    "```",
    "",
    "---",
    "",
    "The end.",
  ].join("\n"),
];

describe("codec ↔ editor equivalence", () => {
  it.each(fixtures.map((f) => [f.slice(0, 40) || "<empty>", f]))(
    "parse matches editor doc JSON: %s",
    (_label, md) => {
      const editor = createEditor(md);
      expect(codec.parse(md)).toEqual(editor.getJSON());
    },
  );

  it.each(fixtures.map((f) => [f.slice(0, 40) || "<empty>", f]))(
    "serialize matches getMarkdown(): %s",
    (_label, md) => {
      const editor = createEditor(md);
      expect(codec.serialize(editor.getJSON())).toBe(getMarkdown(editor));
    },
  );

  it("serializes marks applied by editor commands identically", () => {
    const editor = createEditor("some text");
    editor.commands.selectAll();
    editor.commands.toggleUnderline();
    editor.commands.toggleHighlight();
    expect(codec.serialize(editor.getJSON())).toBe(getMarkdown(editor));
  });

  it("serializes an inserted table identically", () => {
    const editor = createEditor("");
    editor.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: true });
    expect(codec.serialize(editor.getJSON())).toBe(getMarkdown(editor));
  });

  it("hash matches hash.ts", () => {
    expect(codec.hash("# Title\n\nBody")).toBe(
      calculateContentHash("# Title\n\nBody"),
    );
  });
});
