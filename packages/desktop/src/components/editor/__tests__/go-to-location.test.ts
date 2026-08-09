import { describe, it, expect, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import { resolveEditorLocation } from "@/components/editor/editor-position";
import { editorExtensions } from "@/components/editor/tiptap-editor-kit";

/**
 * Mimics searchFileContent: finds `term` in `rawMarkdown`, returns the
 * 1-indexed line and column that the search engine would report.
 */
function rawLineColumn(rawMarkdown: string, term: string) {
  const lines = rawMarkdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const idx = lines[i].indexOf(term);
    if (idx !== -1) {
      return { line: i + 1, column: idx + 1 };
    }
  }
  return { line: 1, column: 1 };
}

/** The raw markdown goToLocation passes to resolveEditorLocation. */
function getMarkdown(editor: Editor): string {
  return (
    editor.storage as unknown as { markdown: { getMarkdown: () => string } }
  ).markdown.getMarkdown();
}

/**
 * goToLocation's core position logic: resolve raw search coordinates
 * against the live doc with the serialized markdown as the raw
 * coordinate space.
 */
function resolveSearchPosition(
  editor: Editor,
  line: number,
  column: number,
  expectedText?: string,
): { from: number; to: number } {
  return resolveEditorLocation(
    editor.state.doc,
    { line, column, expectedText },
    getMarkdown(editor),
  );
}

const editors: Editor[] = [];

function createEditor(content: string) {
  const editor = new Editor({
    extensions: editorExtensions,
    content,
  });
  editors.push(editor);
  return editor;
}

afterEach(() => {
  editors.forEach((e) => e.destroy());
  editors.length = 0;
});

describe("resolveSearchPosition (goToLocation core)", () => {
  it("plain text — line:col maps 1:1", () => {
    const markdown = "Hello World";
    const editor = createEditor(markdown);
    const { line, column } = rawLineColumn(markdown, "Hello");
    const { from, to } = resolveSearchPosition(editor, line, column, "Hello");

    expect(editor.state.doc.textBetween(from, to)).toBe("Hello");
    expect(to - from).toBe("Hello".length);
  });

  it("heading — ## prefix shifts raw column", () => {
    const markdown = "## Hello World";
    const editor = createEditor(markdown);
    // raw markdown: "## Hello" → search gives line 1, column 4
    const { line, column } = rawLineColumn(markdown, "Hello");
    expect(column).toBe(4); // 1-indexed: H is at column 4 after "## "

    const { from, to } = resolveSearchPosition(editor, line, column, "Hello");

    expect(editor.state.doc.textBetween(from, to)).toBe("Hello");
    expect(to - from).toBe(5);
  });

  it("bullet list — - prefix shifts raw column", () => {
    const markdown = "- First item";
    const editor = createEditor(markdown);
    const { line, column } = rawLineColumn(markdown, "First");
    expect(column).toBe(3);

    const { from, to } = resolveSearchPosition(editor, line, column, "First");

    expect(editor.state.doc.textBetween(from, to)).toBe("First");
  });

  it("ordered list — 1. prefix shifts raw column", () => {
    const markdown = "1. First item";
    const editor = createEditor(markdown);
    const { line, column } = rawLineColumn(markdown, "First");
    expect(column).toBe(4);

    const { from, to } = resolveSearchPosition(editor, line, column, "First");

    expect(editor.state.doc.textBetween(from, to)).toBe("First");
  });

  it("task list — - [ ] prefix shifts raw column", () => {
    const markdown = "- [ ] Task one";
    const editor = createEditor(markdown);
    const { line, column } = rawLineColumn(markdown, "Task");
    expect(column).toBe(7);

    const { from, to } = resolveSearchPosition(editor, line, column, "Task");

    expect(editor.state.doc.textBetween(from, to)).toBe("Task");
  });

  it("checked task — - [x] prefix shifts raw column", () => {
    const markdown = "- [x] Done task";
    const editor = createEditor(markdown);
    const { line, column } = rawLineColumn(markdown, "Done");
    expect(column).toBe(7);

    const { from, to } = resolveSearchPosition(editor, line, column, "Done");

    expect(editor.state.doc.textBetween(from, to)).toBe("Done");
  });

  it("blockquote — > prefix shifts raw column", () => {
    const markdown = "> A quote here";
    const editor = createEditor(markdown);
    const { line, column } = rawLineColumn(markdown, "quote");
    expect(column).toBe(5);

    const { from, to } = resolveSearchPosition(editor, line, column, "quote");

    expect(editor.state.doc.textBetween(from, to)).toBe("quote");
  });

  it("code block — fenced code line maps correctly", () => {
    const markdown = "```js\nconst x = 1;\n```";
    const editor = createEditor(markdown);
    const { line, column } = rawLineColumn(markdown, "const");
    expect(line).toBe(2);
    expect(column).toBe(1);

    const { from, to } = resolveSearchPosition(editor, line, column, "const");

    expect(editor.state.doc.textBetween(from, to)).toBe("const");
  });

  it("table cell — no pipe/formatting chars in Tiptap text", () => {
    const markdown = "| Alice | 30 |";
    const editor = createEditor(markdown);
    const { line, column } = rawLineColumn(markdown, "Alice");
    expect(column).toBe(3);

    const { from, to } = resolveSearchPosition(editor, line, column, "Alice");

    expect(editor.state.doc.textBetween(from, to)).toBe("Alice");
  });

  it("stale line hint still lands on the expected text", () => {
    // Even when the caller passes a wrong line hint (here: line 3 points at
    // a different paragraph), the resolver locates the expected text rather
    // than producing an empty/collapsed selection.
    const markdown = [
      "First para.",
      "",
      "Second para.",
      "",
      "Third para.",
    ].join("\n");
    const editor = createEditor(markdown);

    const { from, to } = resolveSearchPosition(editor, 3, 1, "Third");
    expect(editor.state.doc.textBetween(from, to)).toBe("Third");
    expect(to).toBeGreaterThan(from);
  });

  it("multi-word match — full phrase selected", () => {
    const markdown = "First paragraph for drag handle checks.";
    const editor = createEditor(markdown);
    const { line, column } = rawLineColumn(markdown, "drag handle");
    expect(line).toBe(1);

    const { from, to } = resolveSearchPosition(
      editor,
      line,
      column,
      "drag handle",
    );

    expect(editor.state.doc.textBetween(from, to)).toBe("drag handle");
    expect(to - from).toBe(11);
  });

  it("text at document end — no trailing newline", () => {
    const markdown = "hello";
    const editor = createEditor(markdown);
    const { line, column } = rawLineColumn(markdown, "hello");
    const { from, to } = resolveSearchPosition(editor, line, column, "hello");

    expect(editor.state.doc.textBetween(from, to)).toBe("hello");
  });

  it("empty document — clamps to 1", () => {
    const editor = createEditor("");
    const { from, to } = resolveSearchPosition(editor, 1, 1, undefined);

    expect(from).toBe(1);
    expect(to).toBe(1);
  });

  it("text not in document — falls back to line:col", () => {
    const markdown = "hello world";
    const editor = createEditor(markdown);
    const { from, to } = resolveSearchPosition(editor, 1, 7, "xyz");

    // "xyz" isn't in the rendered text, so line 1 col 7 resolves directly:
    // the caret lands before "world" (doc pos 7), collapsed.
    expect(from).toBe(7);
    expect(to).toBe(7);
  });

  it("hello in a task list — matches user's exact document", () => {
    const markdown = "- [ ] world\n- [ ] hello\n- [ ]";
    const editor = createEditor(markdown);

    const { from, to } = resolveSearchPosition(editor, 2, 7, "hello");
    const selected = editor.state.doc.textBetween(from, to);
    expect(selected).toBe("hello");
    expect(to).toBeGreaterThan(from);
  });
});
