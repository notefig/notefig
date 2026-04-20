interface TextNode {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  code?: boolean;
}

interface ElementNode {
  type: string;
  children: (TextNode | ElementNode)[];
  url?: string; // for links
  indent?: number; // for indent-based lists
  listStyleType?: string; // "disc" | "decimal" | etc.
  listStart?: number; // continuation numbering
  lang?: string; // for code blocks
  [key: string]: unknown;
}

export type PlateNode = TextNode | ElementNode;

export const simpleParagraphs: PlateNode[] = [
  {
    type: "p",
    children: [{ text: "Hello world" }],
  },
  {
    type: "p",
    children: [{ text: "This is line two" }],
  },
  {
    type: "p",
    children: [{ text: "Third line here" }],
  },
];

export const headingsAndParagraphs: PlateNode[] = [
  {
    type: "h1",
    children: [{ text: "Main Title" }],
  },
  {
    type: "p",
    children: [{ text: "Introduction paragraph" }],
  },
  {
    type: "h2",
    children: [{ text: "Section One" }],
  },
  {
    type: "p",
    children: [{ text: "Content here" }],
  },
];

export const formattedParagraph: PlateNode[] = [
  {
    type: "p",
    children: [
      { text: "Hello " },
      { text: "bold", bold: true },
      { text: " and " },
      { text: "italic", italic: true },
      { text: " text" },
    ],
  },
];

export const nestedFormatting: PlateNode[] = [
  {
    type: "p",
    children: [
      { text: "Normal " },
      { text: "bold ", bold: true },
      { text: "bold-italic", bold: true, italic: true },
      { text: " bold", bold: true },
      { text: " normal" },
    ],
  },
];

export const codeBlock: PlateNode[] = [
  {
    type: "code_block",
    children: [
      {
        type: "code_line",
        children: [{ text: "function hello() {" }],
      },
      {
        type: "code_line",
        children: [{ text: "  return 'world';" }],
      },
      {
        type: "code_line",
        children: [{ text: "}" }],
      },
    ],
  },
];

export const blockquote: PlateNode[] = [
  {
    type: "blockquote",
    children: [
      {
        type: "p",
        children: [{ text: "This is a quoted paragraph" }],
      },
    ],
  },
];

/**
 * Unordered list using real Plate indent-based structure.
 * Each list item is a flat top-level paragraph with indent + listStyleType.
 */
export const unorderedList: PlateNode[] = [
  {
    type: "p",
    indent: 1,
    listStyleType: "disc",
    children: [{ text: "First item" }],
  },
  {
    type: "p",
    indent: 1,
    listStyleType: "disc",
    listStart: 2,
    children: [{ text: "Second item" }],
  },
  {
    type: "p",
    indent: 1,
    listStyleType: "disc",
    listStart: 3,
    children: [{ text: "Third item" }],
  },
];

/**
 * Mixed content using real Plate AST structure (flat lists).
 *
 * Markdown:
 * Line 1:  # Document Title
 * Line 2:  (blank)
 * Line 3:  First paragraph with **bold** text
 * Line 4:  (blank)
 * Line 5:  * List item one
 * Line 6:  * List item two
 * Line 7:  (blank)
 * Line 8:  > A blockquote
 * Line 9:  (blank)
 * Line 10: Final paragraph
 */
export const mixedContent: PlateNode[] = [
  {
    type: "h1",
    children: [{ text: "Document Title" }],
  },
  {
    type: "p",
    children: [
      { text: "First paragraph with " },
      { text: "bold", bold: true },
      { text: " text" },
    ],
  },
  {
    type: "p",
    indent: 1,
    listStyleType: "disc",
    children: [{ text: "List item one" }],
  },
  {
    type: "p",
    indent: 1,
    listStyleType: "disc",
    listStart: 2,
    children: [{ text: "List item two" }],
  },
  {
    type: "blockquote",
    children: [
      {
        type: "p",
        children: [{ text: "A blockquote" }],
      },
    ],
  },
  {
    type: "p",
    children: [{ text: "Final paragraph" }],
  },
];

export const emptyParagraph: PlateNode[] = [
  {
    type: "p",
    children: [{ text: "" }],
  },
];

export const paragraphWithLink: PlateNode[] = [
  {
    type: "p",
    children: [
      { text: "Click " },
      {
        type: "a",
        url: "https://example.com",
        children: [{ text: "here" }],
      },
      { text: " for more" },
    ],
  },
];

/**
 * Realistic mixed document based on real Plate AST snapshot.
 * Uses flat indent-based lists (not nested ul>li>lic).
 *
 * Markdown (what the search engine sees):
 * Line 1:  # Markdown Document with Image
 * Line 2:  (blank)
 * Line 3:  Introduction text here.
 * Line 4:  (blank)
 * Line 5:  ```typescript
 * Line 6:  const x = 1;
 * Line 7:  const y = 2;
 * Line 8:  const z = 3;
 * Line 9:  ```
 * Line 10: (blank)
 * Line 11: 1. hello
 * Line 12: 2. world
 * Line 13:    1. sub item
 * Line 14: (blank)
 * Line 15: * ul 1
 * Line 16:   * Ul 1.1
 * Line 17: * Ul 2
 * Line 18: (blank)
 * Line 19: > this is a quote
 * Line 20: (blank)
 * Line 21: Between tables paragraph
 * Line 22: (blank)
 * Line 23: | row 0 col 0 | row 0 col 1 | row 0 col 2 |
 * Line 24: | ----------- | ----------- | ----------- |
 * Line 25: | row 1 col 0 | row 1 col 1 | row 1 col 2 |
 * Line 26: | row 2 col 0 | row 2 col 1 | row 2 col 2 |
 * Line 27: (blank)
 * Line 28: Final paragraph.
 *
 * AST: 16 top-level blocks
 */
export const realisticDocument: PlateNode[] = [
  // Block 0 — line 1
  { type: "h1", children: [{ text: "Markdown Document with Image" }] },
  // Block 1 — line 3
  { type: "p", children: [{ text: "Introduction text here." }] },
  // Block 2 — lines 5-9 (code block: fence + 3 code lines + fence)
  {
    type: "code_block",
    lang: "typescript",
    children: [
      { type: "code_line", children: [{ text: "const x = 1;" }] },
      { type: "code_line", children: [{ text: "const y = 2;" }] },
      { type: "code_line", children: [{ text: "const z = 3;" }] },
    ],
  },
  // Block 3 — line 11 (ordered list item 1)
  {
    type: "p",
    indent: 1,
    listStyleType: "decimal",
    children: [{ text: "hello" }],
  },
  // Block 4 — line 12 (ordered list item 2)
  {
    type: "p",
    indent: 1,
    listStyleType: "decimal",
    listStart: 2,
    children: [{ text: "world" }],
  },
  // Block 5 — line 13 (ordered list sub-item)
  {
    type: "p",
    indent: 2,
    listStyleType: "decimal",
    children: [{ text: "sub item" }],
  },
  // Block 6 — line 15 (unordered list item 1)
  {
    type: "p",
    indent: 1,
    listStyleType: "disc",
    children: [{ text: "ul 1" }],
  },
  // Block 7 — line 16 (unordered list sub-item)
  {
    type: "p",
    indent: 2,
    listStyleType: "disc",
    children: [{ text: "Ul 1.1" }],
  },
  // Block 8 — line 17 (unordered list item 2)
  {
    type: "p",
    indent: 1,
    listStyleType: "disc",
    listStart: 2,
    children: [{ text: "Ul 2" }],
  },
  // Block 9 — line 19
  {
    type: "blockquote",
    children: [{ type: "p", children: [{ text: "this is a quote" }] }],
  },
  // Block 10 — line 21
  { type: "p", children: [{ text: "Between tables paragraph" }] },
  // Block 11 — lines 23-26 (table: header + separator + 2 data rows)
  {
    type: "table",
    children: [
      {
        type: "tr",
        children: [
          {
            type: "th",
            children: [{ type: "p", children: [{ text: "row 0 col 0" }] }],
          },
          {
            type: "th",
            children: [{ type: "p", children: [{ text: "row 0 col 1" }] }],
          },
          {
            type: "th",
            children: [{ type: "p", children: [{ text: "row 0 col 2" }] }],
          },
        ],
      },
      {
        type: "tr",
        children: [
          {
            type: "td",
            children: [{ type: "p", children: [{ text: "row 1 col 0" }] }],
          },
          {
            type: "td",
            children: [{ type: "p", children: [{ text: "row 1 col 1" }] }],
          },
          {
            type: "td",
            children: [{ type: "p", children: [{ text: "row 1 col 2" }] }],
          },
        ],
      },
      {
        type: "tr",
        children: [
          {
            type: "td",
            children: [{ type: "p", children: [{ text: "row 2 col 0" }] }],
          },
          {
            type: "td",
            children: [{ type: "p", children: [{ text: "row 2 col 1" }] }],
          },
          {
            type: "td",
            children: [{ type: "p", children: [{ text: "row 2 col 2" }] }],
          },
        ],
      },
    ],
  },
  // Block 12 — line 28
  { type: "p", children: [{ text: "Final paragraph." }] },
];

/**
 * Maps raw markdown line numbers to expected block index and navigable path
 * for the realisticDocument fixture.
 *
 * `path` is the Slate path to the most specific navigable node:
 * - For paragraphs/headings: the block path itself
 * - For code_line inside code_block: the code_line path
 * - For blockquote: the inner paragraph path
 * - For table rows: the table block path (column mapping is separate)
 */
export const realisticDocumentLineMap: Array<{
  rawLine: number;
  blockIndex: number;
  path: number[];
  expectedText: string;
  description: string;
}> = [
  {
    rawLine: 1,
    blockIndex: 0,
    path: [0],
    expectedText: "Markdown Document with Image",
    description: "h1 heading",
  },
  {
    rawLine: 3,
    blockIndex: 1,
    path: [1],
    expectedText: "Introduction text here.",
    description: "paragraph",
  },
  // Code block: line 5 = opening fence (```typescript), lines 6-8 = code, line 9 = closing fence
  {
    rawLine: 6,
    blockIndex: 2,
    path: [2, 0],
    expectedText: "const x = 1;",
    description: "code_line 0 inside code_block",
  },
  {
    rawLine: 7,
    blockIndex: 2,
    path: [2, 1],
    expectedText: "const y = 2;",
    description: "code_line 1 inside code_block",
  },
  {
    rawLine: 8,
    blockIndex: 2,
    path: [2, 2],
    expectedText: "const z = 3;",
    description: "code_line 2 inside code_block",
  },
  // Ordered list items (flat paragraphs, no blank lines between same listStyleType)
  {
    rawLine: 11,
    blockIndex: 3,
    path: [3],
    expectedText: "hello",
    description: "ordered list item 1",
  },
  {
    rawLine: 12,
    blockIndex: 4,
    path: [4],
    expectedText: "world",
    description: "ordered list item 2",
  },
  {
    rawLine: 13,
    blockIndex: 5,
    path: [5],
    expectedText: "sub item",
    description: "ordered list sub-item",
  },
  // Unordered list items (blank line before because listStyleType changed)
  {
    rawLine: 15,
    blockIndex: 6,
    path: [6],
    expectedText: "ul 1",
    description: "unordered list item 1",
  },
  {
    rawLine: 16,
    blockIndex: 7,
    path: [7],
    expectedText: "Ul 1.1",
    description: "unordered list sub-item",
  },
  {
    rawLine: 17,
    blockIndex: 8,
    path: [8],
    expectedText: "Ul 2",
    description: "unordered list item 2",
  },
  // Blockquote
  {
    rawLine: 19,
    blockIndex: 9,
    path: [9, 0],
    expectedText: "this is a quote",
    description: "blockquote inner paragraph",
  },
  // Normal paragraph
  {
    rawLine: 21,
    blockIndex: 10,
    path: [10],
    expectedText: "Between tables paragraph",
    description: "paragraph between blockquote and table",
  },
  // Table: line 23 = header, line 24 = separator, lines 25-26 = data rows
  {
    rawLine: 23,
    blockIndex: 11,
    path: [11],
    expectedText: "row 0 col 0",
    description: "table header row",
  },
  {
    rawLine: 25,
    blockIndex: 11,
    path: [11],
    expectedText: "row 1 col 0",
    description: "table data row 1",
  },
  {
    rawLine: 26,
    blockIndex: 11,
    path: [11],
    expectedText: "row 2 col 0",
    description: "table data row 2",
  },
  // Final paragraph
  {
    rawLine: 28,
    blockIndex: 12,
    path: [12],
    expectedText: "Final paragraph.",
    description: "final paragraph",
  },
];

/**
 * Line map for mixedContent fixture.
 *
 * Markdown:
 * Line 1:  # Document Title
 * Line 2:  (blank)
 * Line 3:  First paragraph with **bold** text
 * Line 4:  (blank)
 * Line 5:  * List item one
 * Line 6:  * List item two
 * Line 7:  (blank)
 * Line 8:  > A blockquote
 * Line 9:  (blank)
 * Line 10: Final paragraph
 */
export const mixedContentLineMap: Array<{
  rawLine: number;
  blockIndex: number;
  path: number[];
  expectedText: string;
}> = [
  { rawLine: 1, blockIndex: 0, path: [0], expectedText: "Document Title" },
  {
    rawLine: 3,
    blockIndex: 1,
    path: [1],
    expectedText: "First paragraph with bold text",
  },
  { rawLine: 5, blockIndex: 2, path: [2], expectedText: "List item one" },
  { rawLine: 6, blockIndex: 3, path: [3], expectedText: "List item two" },
  { rawLine: 8, blockIndex: 4, path: [4, 0], expectedText: "A blockquote" },
  { rawLine: 10, blockIndex: 5, path: [5], expectedText: "Final paragraph" },
];

export const table: PlateNode[] = [
  {
    type: "table",
    children: [
      {
        type: "tr",
        children: [
          {
            type: "th",
            children: [{ type: "p", children: [{ text: "Header 1" }] }],
          },
          {
            type: "th",
            children: [{ type: "p", children: [{ text: "Header 2" }] }],
          },
        ],
      },
      {
        type: "tr",
        children: [
          {
            type: "td",
            children: [{ type: "p", children: [{ text: "Cell 1" }] }],
          },
          {
            type: "td",
            children: [{ type: "p", children: [{ text: "Cell 2" }] }],
          },
        ],
      },
    ],
  },
];
