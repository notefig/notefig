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

export const unorderedList: PlateNode[] = [
  {
    type: "ul",
    children: [
      {
        type: "li",
        children: [
          {
            type: "lic",
            children: [{ text: "First item" }],
          },
        ],
      },
      {
        type: "li",
        children: [
          {
            type: "lic",
            children: [{ text: "Second item" }],
          },
        ],
      },
      {
        type: "li",
        children: [
          {
            type: "lic",
            children: [{ text: "Third item" }],
          },
        ],
      },
    ],
  },
];

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
    type: "ul",
    children: [
      {
        type: "li",
        children: [
          {
            type: "lic",
            children: [{ text: "List item one" }],
          },
        ],
      },
      {
        type: "li",
        children: [
          {
            type: "lic",
            children: [{ text: "List item two" }],
          },
        ],
      },
    ],
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
