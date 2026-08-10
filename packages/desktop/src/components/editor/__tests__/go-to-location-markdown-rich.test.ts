/**
 * Search → selection in markdown-rich documents.
 *
 * The pipeline under test mirrors production exactly: the search backend
 * matches against the RAW file bytes and reports the matched text, its
 * line's content, and which same-text occurrence it is; the search panel
 * passes those through goToLocation → resolveSearchTarget against the
 * live doc. Raw line/columns are deliberately not part of the contract —
 * the document doesn't contain the disk file's bytes, so no coordinate
 * mapping can be exact (the root cause of the original bug).
 *
 * Regression suite for the failure modes that shaped this design:
 * wrong-occurrence selection of repeated terms, code-block newlines
 * miscounted as block separators, and disk bytes the serializer would
 * normalize (frontmatter, hard-wrapped paragraphs, punctuation).
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import { editorExtensions } from "../tiptap-editor-kit";
import {
  resolveSearchTarget,
  type SearchTarget,
} from "../editor-position";

const editors: Editor[] = [];

function createEditor(content: string | object): Editor {
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

/**
 * Mirror of the search backend + panel: find the nth occurrence of
 * `query` in the raw file bytes and build the SearchTarget the panel
 * would pass to navigation.
 */
function searchMatch(
  rawFile: string,
  query: string,
  occurrence = 0,
): SearchTarget {
  const lines = rawFile.split("\n");
  let seen = 0;
  for (const line of lines) {
    let col = line.indexOf(query);
    while (col !== -1) {
      if (seen === occurrence) {
        return { matchText: query, lineText: line, occurrence };
      }
      seen++;
      col = line.indexOf(query, col + 1);
    }
  }
  throw new Error(
    `fixture bug: occurrence ${occurrence} of ${JSON.stringify(query)} not found (got ${seen})`,
  );
}

function navigateToMatch(editor: Editor, target: SearchTarget) {
  return resolveSearchTarget(editor.state.doc, target);
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
 * A document that exercises the constructs whose raw↔rendered drift broke
 * navigation: headings, blank lines, code fences, tables (delimiter row
 * disappears, cells expand), blockquotes, lists.
 */
const RICH_DOC = [
  "# Release Notes",
  "",
  "Intro paragraph with some context.",
  "",
  "## Setup",
  "",
  "The first config lives here in the loader paragraph.",
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
  "> Note about defaults.",
  "",
  "The second config lives here in the defaults paragraph.",
  "",
  "- item one",
  "- item two",
  "",
  "The third config lives here in the tail paragraph.",
].join("\n");

describe("repeated terms select the clicked occurrence", () => {
  it.each([
    [0, "first config"],
    [1, "second config"],
    [2, "third config"],
  ])("occurrence %i lands in the %s paragraph", (occurrence, context) => {
    const editor = createEditor(RICH_DOC);
    const match = searchMatch(RICH_DOC, "config", occurrence);

    const { from, to } = navigateToMatch(editor, match);

    expect(editor.state.doc.textBetween(from, to)).toBe("config");
    expect(blockTextAt(editor, from)).toContain(context);
  });

  it("a match after a table lands in its own paragraph (cell-per-line expansion)", () => {
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

    const { from, to } = navigateToMatch(editor, match);

    expect(editor.state.doc.textBetween(from, to)).toBe("needle");
  });
});

describe("non-canonical disk files (file bytes ≠ rendered document)", () => {
  // Real-world repro (canto-xii): the file on disk was authored by hand /
  // other tools — frontmatter (whose title echoes the H1!), hard-wrapped
  // paragraphs, straight-vs-curly punctuation. The rendered doc knows none
  // of those bytes; lineText similarity + occurrence index must carry
  // navigation.
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
    return createEditor({
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

    const { from, to } = navigateToMatch(editor, match);

    expect(editor.state.doc.textBetween(from, to)).toBe("directory");
    expect(blockTextAt(editor, from)).toBe("What this directory is");
  });
});

describe("matches in raw-only text (no rendered occurrence)", () => {
  it("a match inside a link URL lands on the block containing the link", () => {
    // "example" exists only in the raw URL, never in the rendered text, so
    // the caret parks at the start of the most similar line.
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

    const { from } = navigateToMatch(editor, match);

    expect(blockTextAt(editor, from)).toContain("the docs");
  });
});
