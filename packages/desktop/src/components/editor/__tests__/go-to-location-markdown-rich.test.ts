/**
 * Search "go to line" in markdown-rich documents.
 *
 * The full pipeline under test is the real one:
 *
 *   searchFileContent (raw markdown coords, same contract as search.rs)
 *     → SearchPanel handleMatchClick ({line, column, expectedText})
 *       → goToLocation → resolveEditorLocation with the doc's serialized
 *         markdown (the raw coordinate space)
 *
 * Regression suite for the coordinate-space bugs these scenarios caught:
 * raw-vs-rendered line drift (blank lines, syntax prefixes, fences, table
 * delimiter rows vs cell-per-line expansion), nearest-occurrence fuzzy
 * matching selecting the wrong occurrence of a repeated term, and code
 * block newlines being miscounted as block separators.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import { editorExtensions } from "../tiptap-editor-kit";
import { resolveEditorLocation } from "../editor-position";

const editors: Editor[] = [];

function createEditor(markdown: string): Editor {
  const editor = new Editor({
    extensions: editorExtensions,
    content: markdown,
    editable: true,
    autofocus: false,
  });
  editors.push(editor);
  return editor;
}

function createEditorFromDoc(doc: object): Editor {
  const editor = new Editor({
    extensions: editorExtensions,
    content: doc,
    editable: true,
    autofocus: false,
  });
  editors.push(editor);
  return editor;
}

/** The raw markdown goToLocation passes to resolveEditorLocation. */
function getMarkdown(editor: Editor): string {
  return (
    editor.storage as unknown as { markdown: { getMarkdown: () => string } }
  ).markdown.getMarkdown();
}

afterEach(() => {
  editors.forEach((e) => e.destroy());
  editors.length = 0;
});

/**
 * Mirror of searchFileContent (base-browser-adapter.ts) / search.rs: both
 * backends report 1-indexed line/column against the RAW file content.
 * Reimplemented locally so this test doesn't import the adapter module's
 * platform side effects. Returns the nth match (0-indexed).
 */
function searchMatch(markdown: string, query: string, occurrence = 0) {
  const lines = markdown.split("\n");
  let seen = 0;
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    let col = lines[lineIdx].indexOf(query);
    while (col !== -1) {
      if (seen === occurrence) {
        return {
          location: {
            range: { start: { line: lineIdx + 1, column: col + 1 } },
          },
          content: { matchText: query, lineContent: lines[lineIdx] },
          occurrence,
        };
      }
      seen++;
      col = lines[lineIdx].indexOf(query, col + 1);
    }
  }
  throw new Error(
    `fixture bug: occurrence ${occurrence} of ${JSON.stringify(query)} not found (got ${seen})`,
  );
}

/**
 * Exactly what SearchPanel.handleMatchClick → goToLocation does with a
 * search result: navigate to raw {line, column} with the matched text as
 * the fuzzy hint.
 */
function navigateToMatch(
  editor: Editor,
  match: ReturnType<typeof searchMatch>,
) {
  return resolveEditorLocation(
    editor.state.doc,
    {
      line: match.location.range.start.line,
      column: match.location.range.start.column,
      expectedText: match.content.matchText,
      lineText: match.content.lineContent,
      occurrence: match.occurrence,
    },
    getMarkdown(editor),
  );
}

/** The text of the block (paragraph/heading/cell/…) the position landed in. */
function blockTextAt(editor: Editor, pos: number): string {
  const clamped = Math.max(
    1,
    Math.min(pos, editor.state.doc.content.size - 1),
  );
  return editor.state.doc.resolve(clamped).parent.textContent;
}

/**
 * A document that exercises the constructs whose raw↔rendered line drift
 * triggers the bug: headings, blank lines, code fences, tables (delimiter
 * row disappears, cells expand), blockquotes, lists.
 */
const RICH_DOC = [
  "# Release Notes", //                                          raw line 1
  "",
  "Intro paragraph with some context.",
  "",
  "## Setup",
  "",
  "The first config lives here in the loader paragraph.", //     raw line 7
  "",
  "```js",
  "// setup script",
  "const app = start();",
  "```",
  "",
  "| Key | Value |",
  "| --- | ----- |",
  "| a   | 1     |",
  "| b   | 2     |",
  "",
  "> Note about defaults.", //                                   raw line 19
  "",
  "The second config lives here in the defaults paragraph.", //  raw line 21
  "",
  "- item one",
  "- item two",
  "",
  "The third config lives here in the tail paragraph.", //       raw line 26
].join("\n");

describe("search result → goToLocation in a markdown-rich document", () => {
  it("clicking the FIRST occurrence selects the first occurrence", () => {
    const editor = createEditor(RICH_DOC);
    const match = searchMatch(RICH_DOC, "config", 0);
    expect(match.location.range.start.line).toBe(7); // raw coords sanity

    const { from, to } = navigateToMatch(editor, match);

    expect(editor.state.doc.textBetween(from, to)).toBe("config");
    // Must land in the paragraph the user clicked, not a later occurrence.
    expect(blockTextAt(editor, from)).toContain("first config");
  });

  it("clicking the SECOND occurrence selects the second occurrence", () => {
    const editor = createEditor(RICH_DOC);
    const match = searchMatch(RICH_DOC, "config", 1);
    expect(match.location.range.start.line).toBe(21);

    const { from, to } = navigateToMatch(editor, match);

    expect(editor.state.doc.textBetween(from, to)).toBe("config");
    expect(blockTextAt(editor, from)).toContain("second config");
  });

  it("clicking the LAST occurrence selects the last occurrence", () => {
    const editor = createEditor(RICH_DOC);
    const match = searchMatch(RICH_DOC, "config", 2);
    expect(match.location.range.start.line).toBe(26);

    const { from, to } = navigateToMatch(editor, match);

    expect(editor.state.doc.textBetween(from, to)).toBe("config");
    expect(blockTextAt(editor, from)).toContain("third config");
  });

  it("a match after a table lands in its own paragraph (cell-per-line expansion)", () => {
    // Table cells each become one rendered line, pushing rendered offsets
    // FORWARD while blank/fence/delimiter lines pull them BACKWARD — the
    // two errors don't cancel; either way the hint is wrong.
    const doc = [
      "| Name | Role | Team |",
      "| ---- | ---- | ---- |",
      "| Ada  | eng  | core |",
      "| Lin  | eng  | apps |",
      "",
      "Deploy notes mention target here.",
      "",
      "More filler prose.",
      "",
      "Another target mention at the bottom.",
    ].join("\n");
    const editor = createEditor(doc);
    const match = searchMatch(doc, "target", 0);
    expect(match.location.range.start.line).toBe(6);

    const { from, to } = navigateToMatch(editor, match);

    expect(editor.state.doc.textBetween(from, to)).toBe("target");
    expect(blockTextAt(editor, from)).toContain("Deploy notes");
  });
});

describe("selection alignment (offset mapping)", () => {
  it("stays aligned after a multi-line code block", () => {
    // Newlines INSIDE a code block are real characters of the code block's
    // text node, not block separators — historically each preceding code
    // line dragged the selection one character left.
    const doc = [
      "```js",
      "line one",
      "line two",
      "line three",
      "```",
      "",
      "The unique needle sits here.",
    ].join("\n");
    const editor = createEditor(doc);
    const match = searchMatch(doc, "needle", 0);
    expect(match.location.range.start.line).toBe(7);

    const { from, to } = navigateToMatch(editor, match);

    expect(editor.state.doc.textBetween(from, to)).toBe("needle");
  });
});

describe("plain go-to-line (no expectedText) in a markdown-rich document", () => {
  it("lands on the requested raw line's block", () => {
    const editor = createEditor(RICH_DOC);

    // Raw line 19 is the blockquote. No expectedText → pure line math.
    const { from } = resolveEditorLocation(
      editor.state.doc,
      { line: 19 },
      getMarkdown(editor),
    );

    expect(blockTextAt(editor, from)).toContain("Note about defaults");
  });

  it("is correct even when raw and rendered line numbers agree (PM token drift)", () => {
    // A list has NO raw-only lines: raw line N is rendered line N. The only
    // remaining error is resolveLineColumn counting 1 char per line break
    // where ProseMirror charges 2+ tokens per block boundary — the cursor
    // drifts backwards by ~one position per preceding block.
    const doc = ["- alpha", "- bravo", "- charlie"].join("\n");
    const editor = createEditor(doc);

    const { from } = resolveEditorLocation(
      editor.state.doc,
      {
        line: 3,
        column: 3, // "charlie" starts at raw column 3 (after "- ")
      },
      getMarkdown(editor),
    );

    expect(blockTextAt(editor, from)).toBe("charlie");
  });

  it("column accounts for stripped inline markdown syntax", () => {
    const doc = "Here is **bold text** and then a landmark word.";
    const editor = createEditor(doc);
    // Search reports "landmark" at raw column 38 (asterisks included);
    // rendered text has no asterisks.
    const match = searchMatch(doc, "landmark", 0);

    const { from } = resolveEditorLocation(
      editor.state.doc,
      {
        line: match.location.range.start.line,
        column: match.location.range.start.column,
        // no expectedText — plain line:col navigation must stand on its own
      },
      getMarkdown(editor),
    );

    const word = editor.state.doc.textBetween(from, from + "landmark".length);
    expect(word).toBe("landmark");
  });
});

describe("non-canonical disk files (file bytes ≠ serialized markdown)", () => {
  // Real-world repro (canto-xii): the file on disk was authored by hand /
  // other tools, so its bytes differ from the editor's serialization —
  // frontmatter, hard-wrapped paragraphs, straight-vs-curly punctuation.
  // Search coordinates come from the DISK bytes; any resolution strategy
  // that verifies them against the serialized markdown falls apart. The
  // search panel's occurrence index must carry navigation instead.
  const DISK = [
    "---",
    "title: What this directory is",
    "status: draft",
    "---",
    "",
    "# What this directory is",
    "",
    "**Short version:** `the-inferno` isn't a book project. It's a test",
    "workspace for the Metrists writing app, with public-domain literature",
    "used as filler text.",
    "",
    "hello world. is this even working like it's supposed to.",
    "",
    "## The setup",
    "",
    "The hidden `.metrists/` directory holds the app itself (a Next.js",
    "project), and `.gitignore` contains exactly one line.",
    "",
    "There's also a `.gittt/` directory that looks like a typo'd stray",
    "copy of `.git`.",
  ].join("\n");

  // What the editor actually holds (parsed AST — one paragraph per block,
  // curly apostrophes, no frontmatter), mirroring the user's doc dump.
  function createAstEditor(): Editor {
    return createEditorFromDoc({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 1 },
          content: [{ type: "text", text: "What this directory is" }],
        },
        {
          type: "paragraph",
          content: [
            { type: "text", marks: [{ type: "bold" }], text: "Short version:" },
            { type: "text", text: " " },
            { type: "text", marks: [{ type: "code" }], text: "the-inferno" },
            {
              type: "text",
              text: " isn’t a book project. It’s a test workspace for the Metrists writing app, with public-domain literature used as filler text.",
            },
          ],
        },
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "hello world. is this even working like it’s supposed to.",
            },
          ],
        },
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "The setup" }],
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "The hidden " },
            { type: "text", marks: [{ type: "code" }], text: ".metrists/" },
            {
              type: "text",
              text: " directory holds the app itself (a Next.js project), and ",
            },
            { type: "text", marks: [{ type: "code" }], text: ".gitignore" },
            { type: "text", text: " contains exactly one line." },
          ],
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "There’s also a " },
            { type: "text", marks: [{ type: "code" }], text: ".gittt/" },
            {
              type: "text",
              text: " directory that looks like a typo’d stray copy of ",
            },
            { type: "text", marks: [{ type: "code" }], text: ".git" },
            { type: "text", text: "." },
          ],
        },
      ],
    });
  }

  // "directory" occurrences in DISK: 0 = frontmatter title (raw-only!),
  // 1 = heading, 2 = .metrists paragraph, 3 = .gittt paragraph.

  it("heading occurrence resolves despite the frontmatter echo above it", () => {
    const editor = createAstEditor();
    const match = searchMatch(DISK, "directory", 1);
    expect(match.location.range.start.line).toBe(6); // shifted by frontmatter

    const { from, to } = navigateToMatch(editor, match);

    expect(editor.state.doc.textBetween(from, to)).toBe("directory");
    expect(blockTextAt(editor, from)).toBe("What this directory is");
  });

  it("match on a wrapped paragraph line resolves despite punctuation drift", () => {
    const editor = createAstEditor();
    const match = searchMatch(DISK, "directory", 2);

    const { from, to } = navigateToMatch(editor, match);

    expect(editor.state.doc.textBetween(from, to)).toBe("directory");
    expect(blockTextAt(editor, from)).toContain("directory holds the app");
  });

  it("last occurrence resolves to the .gittt paragraph", () => {
    const editor = createAstEditor();
    const match = searchMatch(DISK, "directory", 3);

    const { from, to } = navigateToMatch(editor, match);

    expect(editor.state.doc.textBetween(from, to)).toBe("directory");
    expect(blockTextAt(editor, from)).toContain("stray copy");
  });

  it("clicking the frontmatter match lands on the heading (best effort)", () => {
    // The frontmatter title exists only in the raw bytes; the closest
    // rendered line is the heading that echoes it.
    const editor = createAstEditor();
    const match = searchMatch(DISK, "directory", 0);
    expect(match.location.range.start.line).toBe(2);

    const { from, to } = navigateToMatch(editor, match);

    expect(editor.state.doc.textBetween(from, to)).toBe("directory");
    expect(blockTextAt(editor, from)).toBe("What this directory is");
  });
});

describe("matches in raw-only text (no rendered occurrence)", () => {
  it("a match inside a link URL lands on the block containing the link", () => {
    // "example" exists only in the raw URL, never in the rendered text, so
    // occurrence matching can't apply and the line fallback must at least
    // land on the right block.
    const doc = [
      "# Links",
      "",
      "Filler paragraph one.",
      "",
      "Filler paragraph two.",
      "",
      "See [the docs](https://example.com/guide) for details.",
      "",
      "Trailing paragraph.",
    ].join("\n");
    const editor = createEditor(doc);
    const match = searchMatch(doc, "example", 0);
    expect(match.location.range.start.line).toBe(7);

    const { from } = navigateToMatch(editor, match);

    expect(blockTextAt(editor, from)).toContain("the docs");
  });
});
