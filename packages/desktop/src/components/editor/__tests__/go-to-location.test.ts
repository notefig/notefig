/**
 * resolveSearchTarget across individual markdown constructs: the matched
 * text must come back selected regardless of the syntax (prefixes, marks,
 * fences, table pipes) that exists only in the raw file.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import {
  resolveSearchTarget,
  type SearchTarget,
} from "@/components/editor/editor-position";
import { editorExtensions } from "@/components/editor/tiptap-editor-kit";

/**
 * Mimics the search backend + panel: locate `term` in the raw markdown
 * and build the SearchTarget the panel would pass to navigation.
 */
function rawSearchTarget(rawMarkdown: string, term: string): SearchTarget {
  for (const line of rawMarkdown.split("\n")) {
    if (line.includes(term)) {
      return { matchText: term, lineText: line, occurrence: 0 };
    }
  }
  return { matchText: term, lineText: "", occurrence: 0 };
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

function resolve(editor: Editor, target: SearchTarget) {
  return resolveSearchTarget(editor.state.doc, target);
}

describe("resolveSearchTarget (goToLocation core)", () => {
  it.each([
    ["plain text", "Hello World", "Hello"],
    ["heading — ## prefix", "## Hello World", "Hello"],
    ["bullet list — - prefix", "- First item", "First"],
    ["ordered list — 1. prefix", "1. First item", "First"],
    ["task list — - [ ] prefix", "- [ ] Task one", "Task"],
    ["checked task — - [x] prefix", "- [x] Done task", "Done"],
    ["blockquote — > prefix", "> A quote here", "quote"],
    ["code block — fenced line", "```js\nconst x = 1;\n```", "const"],
    ["table cell — pipe syntax", "| Alice | 30 |", "Alice"],
    ["document end — no trailing newline", "hello", "hello"],
  ])("%s", (_name, markdown, term) => {
    const editor = createEditor(markdown);

    const { from, to } = resolve(editor, rawSearchTarget(markdown, term));

    expect(editor.state.doc.textBetween(from, to)).toBe(term);
    expect(to - from).toBe(term.length);
  });

  it("multi-word match — full phrase selected", () => {
    const markdown = "First paragraph for drag handle checks.";
    const editor = createEditor(markdown);

    const { from, to } = resolve(
      editor,
      rawSearchTarget(markdown, "drag handle"),
    );

    expect(editor.state.doc.textBetween(from, to)).toBe("drag handle");
  });

  it("blank-line-separated paragraphs — match found past compaction", () => {
    const markdown = [
      "First para.",
      "",
      "Second para.",
      "",
      "Third para.",
    ].join("\n");
    const editor = createEditor(markdown);

    const { from, to } = resolve(editor, rawSearchTarget(markdown, "Third"));

    expect(editor.state.doc.textBetween(from, to)).toBe("Third");
  });

  it("empty document — collapses to the start", () => {
    const editor = createEditor("");

    const { from, to } = resolve(editor, {
      matchText: "anything",
      lineText: "",
      occurrence: 0,
    });

    expect(from).toBe(1);
    expect(to).toBe(1);
  });

  it("text not in document — caret parks on the reported line", () => {
    const markdown = "hello world";
    const editor = createEditor(markdown);

    const { from, to } = resolve(editor, {
      matchText: "xyz",
      lineText: "hello world",
      occurrence: 0,
    });

    expect(from).toBe(to); // collapsed, no bogus selection
    expect(from).toBe(1); // start of the only (most similar) line
  });

  it("hello in a task list — matches user's exact document", () => {
    const markdown = "- [ ] world\n- [ ] hello\n- [ ]";
    const editor = createEditor(markdown);

    const { from, to } = resolve(editor, rawSearchTarget(markdown, "hello"));

    expect(editor.state.doc.textBetween(from, to)).toBe("hello");
  });
});
