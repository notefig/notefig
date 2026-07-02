import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import { resolveLineColumn, textOffsetToDocPos } from "@/components/editor/editor-store";
import { fuzzyFind } from "@/utils/navigation-utils";
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

/**
 * Replicates goToLocation's core position logic:
 * 1. resolveLineColumn from raw markdown coordinates
 * 2. fuzzyFind override when expectedText available
 */
function resolveSearchPosition(
  editor: Editor,
  line: number,
  column: number,
  expectedText?: string,
): { from: number; to: number } {
  const doc = editor.state.doc;
  const fullText = doc.textBetween(0, doc.content.size, "\n", "\n");
  let startPos = resolveLineColumn(doc, fullText, line, column);
  let endPos = startPos;

  if (expectedText) {
    const fuzzyOffset = fuzzyFind(fullText, expectedText, startPos - 1);
    if (fuzzyOffset !== -1) {
      let startSep = 0, endSep = 0;
      const textEnd = fuzzyOffset + expectedText.length;
      for (let i = 0; i < textEnd; i++) {
        if (fullText[i] === "\n") {
          if (i < fuzzyOffset) startSep++;
          endSep++;
        }
      }
      startPos = textOffsetToDocPos(doc, fuzzyOffset - startSep);
      endPos = textOffsetToDocPos(doc, textEnd - 1 - endSep) + 1;
    }
  }

  return { from: startPos, to: endPos };
}

function createEditor(content: string) {
  return new Editor({
    extensions: editorExtensions,
    content,
  });
}

describe("resolveSearchPosition (goToLocation core)", () => {
  it("plain text — line:col maps 1:1", () => {
    const markdown = "Hello World";
    const editor = createEditor(markdown);
    const { line, column } = rawLineColumn(markdown, "Hello");
    const { from, to } = resolveSearchPosition(editor, line, column, "Hello");

    expect(editor.state.doc.textBetween(from, to)).toBe("Hello");
    expect(to - from).toBe("Hello".length);
    editor.destroy();
  });

  it("heading — ## prefix shifts raw column, fuzzyFind corrects", () => {
    const markdown = "## Hello World";
    const editor = createEditor(markdown);
    // raw markdown: "## Hello" → search gives line 1, column 4
    const { line, column } = rawLineColumn(markdown, "Hello");
    expect(column).toBe(4); // 1-indexed: H is at column 4 after "## "

    const { from, to } = resolveSearchPosition(editor, line, column, "Hello");

    expect(editor.state.doc.textBetween(from, to)).toBe("Hello");
    // Hello starts at position 2 in Tiptap (after heading node boundary)
    expect(to - from).toBe(5);
    editor.destroy();
  });

  it("bullet list — - prefix shifts raw column", () => {
    const markdown = "- First item";
    const editor = createEditor(markdown);
    const { line, column } = rawLineColumn(markdown, "First");
    expect(column).toBe(3);

    const { from, to } = resolveSearchPosition(editor, line, column, "First");

    expect(editor.state.doc.textBetween(from, to)).toBe("First");
    editor.destroy();
  });

  it("ordered list — 1. prefix shifts raw column", () => {
    const markdown = "1. First item";
    const editor = createEditor(markdown);
    const { line, column } = rawLineColumn(markdown, "First");
    expect(column).toBe(4);

    const { from, to } = resolveSearchPosition(editor, line, column, "First");

    expect(editor.state.doc.textBetween(from, to)).toBe("First");
    editor.destroy();
  });

  it("task list — - [ ] prefix shifts raw column", () => {
    const markdown = "- [ ] Task one";
    const editor = createEditor(markdown);
    const { line, column } = rawLineColumn(markdown, "Task");
    expect(column).toBe(7);

    const { from, to } = resolveSearchPosition(editor, line, column, "Task");

    expect(editor.state.doc.textBetween(from, to)).toBe("Task");
    editor.destroy();
  });

  it("checked task — - [x] prefix shifts raw column", () => {
    const markdown = "- [x] Done task";
    const editor = createEditor(markdown);
    const { line, column } = rawLineColumn(markdown, "Done");
    expect(column).toBe(7);

    const { from, to } = resolveSearchPosition(editor, line, column, "Done");

    expect(editor.state.doc.textBetween(from, to)).toBe("Done");
    editor.destroy();
  });

  it("blockquote — > prefix shifts raw column", () => {
    const markdown = "> A quote here";
    const editor = createEditor(markdown);
    const { line, column } = rawLineColumn(markdown, "quote");
    expect(column).toBe(5);

    const { from, to } = resolveSearchPosition(editor, line, column, "quote");

    expect(editor.state.doc.textBetween(from, to)).toBe("quote");
    editor.destroy();
  });

  it("code block — fenced code line maps correctly", () => {
    const markdown = "```js\nconst x = 1;\n```";
    const editor = createEditor(markdown);
    const { line, column } = rawLineColumn(markdown, "const");
    expect(line).toBe(2);
    expect(column).toBe(1);

    const { from, to } = resolveSearchPosition(editor, line, column, "const");

    expect(editor.state.doc.textBetween(from, to)).toBe("const");
    editor.destroy();
  });

  it("table cell — no pipe/formatting chars in Tiptap text", () => {
    const markdown = "| Alice | 30 |";
    const editor = createEditor(markdown);
    const { line, column } = rawLineColumn(markdown, "Alice");
    expect(column).toBe(3);

    const { from, to } = resolveSearchPosition(editor, line, column, "Alice");

    expect(editor.state.doc.textBetween(from, to)).toBe("Alice");
    editor.destroy();
  });

  it("text found via fuzzyFind produces non-empty selection", () => {
    // Even when resolveLineColumn gives a bad hint (raw-line empty lines
    // are compacted in Tiptap), fuzzyFind always locates the text somewhere
    // in the document rather than producing an empty/collapsed selection.
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
    editor.destroy();
  });

  it("multi-word match — full phrase selected", () => {
    const markdown = "First paragraph for drag handle checks.";
    const editor = createEditor(markdown);
    const { line, column } = rawLineColumn(markdown, "drag handle");
    // raw line 1, column starts at 'd' in "drag"
    expect(line).toBe(1);

    const { from, to } = resolveSearchPosition(
      editor,
      line,
      column,
      "drag handle",
    );

    expect(editor.state.doc.textBetween(from, to)).toBe("drag handle");
    expect(to - from).toBe(11);
    editor.destroy();
  });

  it("text at document end — no trailing newline", () => {
    const markdown = "hello";
    const editor = createEditor(markdown);
    const { line, column } = rawLineColumn(markdown, "hello");
    const { from, to } = resolveSearchPosition(editor, line, column, "hello");

    expect(editor.state.doc.textBetween(from, to)).toBe("hello");
    editor.destroy();
  });

  it("empty document — clamps to 1", () => {
    const editor = createEditor("");
    const { from, to } = resolveSearchPosition(editor, 1, 1, undefined);

    expect(from).toBe(1);
    expect(to).toBe(1);
    editor.destroy();
  });

  it("text not in document — fuzzyFind returns -1, falls back to line:col", () => {
    const markdown = "hello world";
    const editor = createEditor(markdown);
    const { from, to } = resolveSearchPosition(editor, 1, 7, "xyz");

    // fuzzyFind failed, so from = resolveLineColumn(1, 7) = 7
    // endPos = from (since no expectedText match)
    expect(from).toBe(7);
    expect(to).toBe(7);
    editor.destroy();
  });

  it("hello in a task list — matches user's exact document", () => {
    const markdown = "- [ ] world\n- [ ] hello\n- [ ]";
    const editor = createEditor(markdown);

    const { from, to } = resolveSearchPosition(editor, 2, 7, "hello");
    const selected = editor.state.doc.textBetween(from, to);
    expect(selected).toBe("hello");
    expect(to).toBeGreaterThan(from);
    editor.destroy();
  });
});
