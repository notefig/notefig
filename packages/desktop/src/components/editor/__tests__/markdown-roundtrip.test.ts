/**
 * Markdown round-trip identity tests.
 *
 * The editor autosaves `editor.storage.markdown.getMarkdown()` to disk, and
 * re-parses markdown on load / external change. Any feature that does not
 * round-trip losslessly gets silently corrupted in the user's file the moment
 * they touch a document containing it. These tests pin the contract:
 *
 *   parse(markdown) -> serialize === markdown        (identity, canonical form)
 *   serialize(parse(serialize(parse(md)))) === serialize(parse(md))  (stability)
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import { editorExtensions } from "../tiptap-editor-kit";

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

/** parse markdown into a fresh editor, serialize it back out */
function roundTrip(markdown: string): string {
  return getMarkdown(createEditor(markdown));
}

/** The canonical form must survive a parse→serialize cycle unchanged. */
function expectIdentity(markdown: string) {
  expect(roundTrip(markdown)).toBe(markdown);
}

/**
 * Non-canonical input may normalize once (e.g. `*` bullets → `-`), but the
 * result must be a fixed point: normalizing again must change nothing.
 */
function expectStable(markdown: string) {
  const once = roundTrip(markdown);
  const twice = roundTrip(once);
  expect(twice).toBe(once);
}

describe("identity round-trip (canonical markdown)", () => {
  it("paragraph", () => expectIdentity("Hello world"));

  it("multiple paragraphs", () => expectIdentity("First\n\nSecond"));

  it.each([1, 2, 3, 4, 5, 6])("heading level %i", (level) => {
    expectIdentity(`${"#".repeat(level)} Heading`);
  });

  it("bold", () => expectIdentity("Some **bold** text"));

  it("italic", () => expectIdentity("Some *italic* text"));

  it("bold + italic combined", () =>
    expectIdentity("Some ***bold italic*** text"));

  it("strikethrough", () => expectIdentity("Some ~~struck~~ text"));

  it("inline code", () => expectIdentity("Some `code` text"));

  it("link", () =>
    expectIdentity("Visit [example](https://example.com) today"));

  it("blockquote", () => expectIdentity("> Quoted text"));

  it("horizontal rule", () => expectIdentity("Above\n\n---\n\nBelow"));

  it("tight bullet list", () => expectIdentity("- one\n- two\n- three"));

  it("nested bullet list", () =>
    expectIdentity("- parent\n  - child\n  - child two"));

  it("ordered list", () => expectIdentity("1. one\n2. two\n3. three"));

  it("code block with language", () =>
    expectIdentity("```ts\nconst x = 1;\n```"));

  it("code block without language", () =>
    expectIdentity("```\nplain text\n```"));

  it("task list — unchecked (Bug #7)", () => expectIdentity("- [ ] todo"));

  it("task list — checked (Bug #7)", () => expectIdentity("- [x] done"));

  it("task list — mixed (Bug #7)", () =>
    expectIdentity("- [ ] first\n- [x] second\n- [ ] third"));

  it("task list with formatting inside (Bug #7)", () =>
    expectIdentity("- [ ] has **bold** content"));

  it("task list — empty unchecked item (Bug #7)", () =>
    expectIdentity("- [ ]"));

  it("task list — empty checked item (Bug #7)", () => expectIdentity("- [x]"));

  it("task list — empty item among full items (Bug #7)", () =>
    expectIdentity("- [ ] first\n- [ ]\n- [x] third"));

  it("task list — loose input stays loose", () =>
    expectIdentity("- [ ] first\n\n- [x] second"));

  it("underline as inline html", () =>
    expectIdentity("Some <u>underlined</u> text"));

  it("highlight as inline html", () =>
    expectIdentity("Some <mark>highlighted</mark> text"));

  it("subscript as inline html", () => expectIdentity("H<sub>2</sub>O"));

  it("superscript as inline html", () => expectIdentity("x<sup>2</sup>"));

  it("image on its own line", () =>
    expectIdentity("Before\n\n![alt text](assets/pic.png)\n\nAfter"));
});

describe("frontmatter (MET-137)", () => {
  it("frontmatter round-trips byte-identical", () =>
    expectIdentity("---\ntitle: Hello\ntags:\n  - a\n  - b\n---\n\n# Heading"));

  it("comments and key order survive", () =>
    expectIdentity(
      "---\n# reviewed 2026-08\nzeta: 1\nalpha: 2\n---\n\nBody",
    ));

  it("frontmatter-only file", () =>
    expectIdentity("---\ntitle: only frontmatter\n---"));

  it("empty frontmatter is dropped on save (empty node = no fences)", () => {
    // Deleting the last property leaves an empty node; it must serialize
    // to nothing, which also normalizes bare "---\n---" fences away.
    expect(roundTrip("---\n---")).toBe("");
    expectStable("---\n---");
  });

  it("missing blank line after closing fence normalizes once", () =>
    expectStable("---\ntitle: x\n---\n# Heading"));

  it("unclosed opening fence stays a horizontal rule", () => {
    expectIdentity("---\n\nBelow");
    const editor = createEditor("---\n\nBelow");
    expect(editor.getJSON().content?.[0]?.type).toBe("horizontalRule");
  });

  it("mid-document --- is not frontmatter", () => {
    const editor = createEditor("Above\n\n---\n\nBelow");
    expect(editor.getJSON().content?.[0]?.type).toBe("paragraph");
    expectIdentity("Above\n\n---\n\nBelow");
  });

  it("parses into a frontmatter node carrying the raw yaml", () => {
    const editor = createEditor("---\ntitle: Hello\n---\n\nBody");
    const first = editor.getJSON().content?.[0];
    expect(first?.type).toBe("frontmatter");
    expect(first?.attrs?.yaml).toBe("title: Hello");
    // The YAML must not leak into the rendered document text.
    expect(editor.getText()).not.toContain("title");
  });
});

describe("stability round-trip (may normalize once, then fixed)", () => {
  it("asterisk bullets normalize to dashes", () =>
    expectStable("* one\n* two"));

  it("underscore emphasis", () => expectStable("Some _italic_ text"));

  it("hard break", () => expectStable("line one  \nline two"));

  it("setext heading", () => expectStable("Heading\n===="));

  it("kitchen sink document", () =>
    expectStable(
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
    ));
});

describe("marks without native markdown syntax", () => {
  // These extensions are in the toolbar/kit, so a user can apply them — the
  // serialized file must not silently drop them (html is disabled in the
  // Markdown config, which is the suspected loss path).
  it("underline survives round-trip", () => {
    const editor = createEditor("some text");
    editor.commands.selectAll();
    editor.commands.toggleUnderline();
    const md = getMarkdown(editor);
    const reparsed = roundTrip(md);
    expect(reparsed).toBe(md);
    // the mark itself must survive, not just the text
    const second = createEditor(md);
    expect(second.getHTML()).toContain("<u>");
  });

  it("highlight survives round-trip", () => {
    const editor = createEditor("some text");
    editor.commands.selectAll();
    editor.commands.toggleHighlight();
    const md = getMarkdown(editor);
    const second = createEditor(md);
    expect(second.getHTML()).toContain("<mark>");
  });

  it("subscript survives round-trip", () => {
    const editor = createEditor("some text");
    editor.commands.selectAll();
    editor.commands.toggleSubscript();
    const md = getMarkdown(editor);
    const second = createEditor(md);
    expect(second.getHTML()).toContain("<sub>");
  });

  it("superscript survives round-trip", () => {
    const editor = createEditor("some text");
    editor.commands.selectAll();
    editor.commands.toggleSuperscript();
    const md = getMarkdown(editor);
    const second = createEditor(md);
    expect(second.getHTML()).toContain("<sup>");
  });
});

describe("tables (Bug #4)", () => {
  const pipeTable = [
    "| Name | Age |",
    "| --- | --- |",
    "| Alice | 30 |",
    "| Bob | 25 |",
  ].join("\n");

  it("pipe table parses into a table node", () => {
    const editor = createEditor(pipeTable);
    expect(editor.getHTML()).toContain("<table");
    expect(editor.getHTML()).toContain("Alice");
  });

  it("pipe table round-trips", () => expectStable(pipeTable));

  it("inserted table survives serialize→parse", () => {
    const editor = createEditor("");
    editor.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: true });
    const md = getMarkdown(editor);
    const reparsed = createEditor(md);
    expect(reparsed.getHTML()).toContain("<table");
  });
});

describe("content preservation (stability alone is not enough — dropped content is 'stable')", () => {
  it("image node and path survive a save cycle", () => {
    const out = roundTrip("Before\n\n![alt text](assets/pic.png)\n\nAfter");
    expect(out).toContain("![alt text](assets/pic.png)");
    expect(out).toContain("Before");
    expect(out).toContain("After");
  });

  it("image in the middle of a paragraph is not deleted", () => {
    // Image is a block node, so a mid-paragraph image may split the
    // paragraph (acceptable normalization) — but the image must survive.
    const out = roundTrip("text before ![inline](pic.png) text after");
    expect(out).toContain("![inline](pic.png)");
    expect(out).toContain("text before");
    expect(out).toContain("text after");
    expectStable("text before ![inline](pic.png) text after");
  });

  it("unknown html block: text content survives, then stable", () => {
    // With html:true, tags with no matching node (div, span…) are unwrapped
    // on the first save — a documented trade-off (see plan doc). The text
    // inside must never be lost, and the result must be a fixed point.
    const out = roundTrip("Before\n\n<div>raw html</div>\n\nAfter");
    expect(out).toContain("raw html");
    expect(out).toContain("Before");
    expect(out).toContain("After");
    expectStable("Before\n\n<div>raw html</div>\n\nAfter");
  });
});

describe("commands produce serializable nodes", () => {
  it("toggleTaskList on a paragraph serializes as a task item (Bug #7)", () => {
    const editor = createEditor("buy milk");
    editor.commands.selectAll();
    editor.commands.toggleTaskList();
    expect(getMarkdown(editor)).toBe("- [ ] buy milk");
  });

  it("setContent parses markdown, not literal text (external change path)", () => {
    const editor = createEditor("initial");
    editor.commands.setContent("- [ ] from disk", { emitUpdate: false });
    const html = editor.getHTML();
    expect(html).toContain('data-type="taskList"');
    expect(getMarkdown(editor)).toBe("- [ ] from disk");
  });

  it("setContent with heading markdown parses to a heading", () => {
    const editor = createEditor("initial");
    editor.commands.setContent("# Title", { emitUpdate: false });
    expect(editor.getHTML()).toContain("<h1");
  });
});
