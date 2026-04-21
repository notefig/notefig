import { describe, it, expect } from "vitest";
import { Node, type Descendant, Element, Text } from "slate";
import {
  fuzzyFind,
  lineColumnToTextareaOffset,
  columnToOffset,
  markupPrefixLength,
  rawLineToBlockPath,
  type BlockNode,
} from "@/utils/navigation-utils";

import {
  simpleParagraphs,
  headingsAndParagraphs,
  formattedParagraph,
  nestedFormatting,
  mixedContent,
  mixedContentLineMap,
  emptyParagraph,
  paragraphWithLink,
  realisticDocument,
  realisticDocumentLineMap,
  embeddedNewlines,
  embeddedNewlinesLineMap,
  frontmatterEmptyParagraphsAndTodos,
  frontmatterEmptyParagraphsAndTodosLineMap,
  codeBlock,
  blockquote,
  unorderedList,
  table,
} from "@/components/editor/__fixtures__/plate-ast-fixtures";

/**
 * Simple wrapper to allow Node utilities to work with our fixtures.
 * We just need an object with a children array.
 */
interface MockEditor {
  children: Descendant[];
}

function createTestEditor(nodes: Descendant[]): MockEditor {
  return { children: nodes };
}

/**
 * Helper to check if a node is a block element (has type and children).
 */
function isBlock(node: unknown): node is Element {
  return Element.isElement(node) && !Text.isText(node);
}

/**
 * Old lineToBlockPath (kept for backward-compat tests).
 * Each top-level block = a "line". This is the BROKEN behavior.
 */
function lineToBlockPath(editor: MockEditor, line: number): [number] | null {
  const blocks: Array<[Descendant, [number]]> = [];

  for (let i = 0; i < editor.children.length; i++) {
    const child = editor.children[i];
    if (isBlock(child)) {
      blocks.push([child, [i]]);
    }
  }

  if (line < 1 || line > blocks.length) {
    return null;
  }

  return blocks[line - 1][1];
}

/**
 * Simulates findTextNodePath logic - finds text node path for absolute offset.
 */
function findTextNodePath(
  editor: MockEditor,
  blockPath: number[],
  absoluteOffset: number,
): { path: number[]; offset: number; absoluteOffset: number } | null {
  const block = Node.get(editor as unknown as Node, blockPath);
  const textNodes = Array.from(Node.texts(block, { from: [] }));

  if (textNodes.length === 0) {
    return { path: [...blockPath, 0], offset: 0, absoluteOffset: 0 };
  }

  let accumulatedOffset = 0;

  for (const [textNode, relativePath] of textNodes) {
    const textLength = textNode.text.length;
    const startOffset = accumulatedOffset;
    const endOffset = startOffset + textLength;

    if (absoluteOffset <= endOffset) {
      return {
        path: [...blockPath, ...relativePath],
        offset: absoluteOffset - startOffset,
        absoluteOffset: startOffset,
      };
    }

    accumulatedOffset = endOffset;
  }

  // Offset past end - return last position
  const lastText = textNodes[textNodes.length - 1];
  return {
    path: [...blockPath, ...lastText[1]],
    offset: lastText[0].text.length,
    absoluteOffset: accumulatedOffset - lastText[0].text.length,
  };
}

// ===================================================================
// rawLineToBlockPath tests
// ===================================================================

describe("rawLineToBlockPath", () => {
  describe("simple paragraphs (3 paragraphs, lines 1/3/5)", () => {
    /**
     * Line 1: Hello world
     * Line 2: (blank)
     * Line 3: This is line two
     * Line 4: (blank)
     * Line 5: Third line here
     */
    it("should map line 1 to block 0", () => {
      const result = rawLineToBlockPath(simpleParagraphs as BlockNode[], 1);
      expect(result).not.toBeNull();
      expect(result!.path).toEqual([0]);
      expect(result!.blockIndex).toBe(0);
    });

    it("should map line 3 to block 1 (skipping blank line)", () => {
      const result = rawLineToBlockPath(simpleParagraphs as BlockNode[], 3);
      expect(result).not.toBeNull();
      expect(result!.path).toEqual([1]);
    });

    it("should map line 5 to block 2", () => {
      const result = rawLineToBlockPath(simpleParagraphs as BlockNode[], 5);
      expect(result).not.toBeNull();
      expect(result!.path).toEqual([2]);
    });

    it("should return separator mapping for blank line 2 (not null)", () => {
      // Line 2 in the file is a blank separator between block 0 and block 1.
      // Plate doesn't display it, so we map it to the preceding block.
      const result = rawLineToBlockPath(simpleParagraphs as BlockNode[], 2);
      expect(result).not.toBeNull();
      expect(result!.isSeparatorLine).toBe(true);
    });

    it("should return null for line 0", () => {
      expect(rawLineToBlockPath(simpleParagraphs as BlockNode[], 0)).toBeNull();
    });

    it("should return null for line beyond document", () => {
      expect(
        rawLineToBlockPath(simpleParagraphs as BlockNode[], 10),
      ).toBeNull();
    });
  });

  describe("headings and paragraphs (lines 1/3/5/7)", () => {
    /**
     * Line 1: # Main Title
     * Line 2: (blank)
     * Line 3: Introduction paragraph
     * Line 4: (blank)
     * Line 5: ## Section One
     * Line 6: (blank)
     * Line 7: Content here
     */
    it("should map line 1 to h1 block 0", () => {
      const result = rawLineToBlockPath(
        headingsAndParagraphs as BlockNode[],
        1,
      );
      expect(result!.path).toEqual([0]);
    });

    it("should map line 5 to h2 block 2", () => {
      const result = rawLineToBlockPath(
        headingsAndParagraphs as BlockNode[],
        5,
      );
      expect(result!.path).toEqual([2]);
    });

    it("should map line 7 to p block 3", () => {
      const result = rawLineToBlockPath(
        headingsAndParagraphs as BlockNode[],
        7,
      );
      expect(result!.path).toEqual([3]);
    });
  });

  describe("code block (fence + 3 lines + fence = 5 lines)", () => {
    /**
     * Line 1: ```
     * Line 2: function hello() {
     * Line 3:   return 'world';
     * Line 4: }
     * Line 5: ```
     */
    it("should mark line 1 as fence", () => {
      const result = rawLineToBlockPath(codeBlock as BlockNode[], 1);
      expect(result!.isFenceLine).toBe(true);
      expect(result!.path).toEqual([0]);
    });

    it("should map line 2 to code_line 0", () => {
      const result = rawLineToBlockPath(codeBlock as BlockNode[], 2);
      expect(result!.path).toEqual([0, 0]);
      expect(result!.isFenceLine).toBe(false);
    });

    it("should map line 3 to code_line 1", () => {
      const result = rawLineToBlockPath(codeBlock as BlockNode[], 3);
      expect(result!.path).toEqual([0, 1]);
    });

    it("should map line 4 to code_line 2", () => {
      const result = rawLineToBlockPath(codeBlock as BlockNode[], 4);
      expect(result!.path).toEqual([0, 2]);
    });

    it("should mark line 5 as closing fence", () => {
      const result = rawLineToBlockPath(codeBlock as BlockNode[], 5);
      expect(result!.isFenceLine).toBe(true);
    });
  });

  describe("blockquote", () => {
    /**
     * Line 1: > This is a quoted paragraph
     */
    it("should map to inner paragraph path [0, 0]", () => {
      const result = rawLineToBlockPath(blockquote as BlockNode[], 1);
      expect(result!.path).toEqual([0, 0]);
    });
  });

  describe("unordered list (flat indent-based, no blank separators)", () => {
    /**
     * Line 1: * First item
     * Line 2: * Second item
     * Line 3: * Third item
     *
     * All 3 blocks have listStyleType: "disc", so no blank lines between them.
     */
    it("should map line 1 to block 0", () => {
      const result = rawLineToBlockPath(unorderedList as BlockNode[], 1);
      expect(result!.path).toEqual([0]);
    });

    it("should map line 2 to block 1 (no blank separator)", () => {
      const result = rawLineToBlockPath(unorderedList as BlockNode[], 2);
      expect(result!.path).toEqual([1]);
    });

    it("should map line 3 to block 2 (no blank separator)", () => {
      const result = rawLineToBlockPath(unorderedList as BlockNode[], 3);
      expect(result!.path).toEqual([2]);
    });

    it("should return null for line 4 (past end)", () => {
      expect(rawLineToBlockPath(unorderedList as BlockNode[], 4)).toBeNull();
    });
  });

  describe("table (header + separator + data rows)", () => {
    /**
     * Line 1: | Header 1 | Header 2 |
     * Line 2: | -------- | -------- |
     * Line 3: | Cell 1   | Cell 2   |
     */
    it("should map line 1 to table block (header row)", () => {
      const result = rawLineToBlockPath(table as BlockNode[], 1);
      expect(result!.path).toEqual([0]);
      expect(result!.isSeparatorLine).toBe(false);
    });

    it("should mark line 2 as separator", () => {
      const result = rawLineToBlockPath(table as BlockNode[], 2);
      expect(result!.isSeparatorLine).toBe(true);
    });

    it("should map line 3 to table block (data row)", () => {
      const result = rawLineToBlockPath(table as BlockNode[], 3);
      expect(result!.path).toEqual([0]);
      expect(result!.isSeparatorLine).toBe(false);
    });
  });

  describe("mixedContent — line map", () => {
    it.each(mixedContentLineMap)(
      "should map raw line $rawLine to path $path ($expectedText)",
      ({ rawLine, blockIndex, path, expectedText }) => {
        const result = rawLineToBlockPath(mixedContent as BlockNode[], rawLine);
        expect(result).not.toBeNull();
        expect(result!.blockIndex).toBe(blockIndex);
        expect(result!.path).toEqual(path);

        // Verify text at the resolved path
        const editor = createTestEditor(mixedContent as Descendant[]);
        const node = Node.get(editor as unknown as Node, path);
        const text = Node.string(node);
        expect(text).toContain(expectedText);
      },
    );
  });

  describe("realisticDocument — comprehensive line map", () => {
    it.each(realisticDocumentLineMap)(
      "should map raw line $rawLine to path $path ($description)",
      ({ rawLine, blockIndex, path, expectedText }) => {
        const result = rawLineToBlockPath(
          realisticDocument as BlockNode[],
          rawLine,
        );
        expect(result).not.toBeNull();
        expect(result!.blockIndex).toBe(blockIndex);
        expect(result!.path).toEqual(path);

        // Verify text at the resolved path
        const editor = createTestEditor(realisticDocument as Descendant[]);
        const node = Node.get(editor as unknown as Node, path);
        const text = Node.string(node);
        expect(text).toContain(expectedText);
      },
    );

    it("should return separator mapping for blank lines (Plate doesn't display them)", () => {
      // Blank lines in the file are separator lines between blocks.
      // Plate doesn't display these lines, so we map them to the preceding block
      // with isSeparatorLine=true (instead of returning null).
      const blanks = [2, 4, 10, 14, 18, 20, 22, 27];
      for (const line of blanks) {
        const result = rawLineToBlockPath(
          realisticDocument as BlockNode[],
          line,
        );
        expect(result).not.toBeNull();
        expect(result!.isSeparatorLine).toBe(true);
      }
    });

    it("should mark code fence lines", () => {
      // Line 5 = opening fence, line 9 = closing fence
      expect(
        rawLineToBlockPath(realisticDocument as BlockNode[], 5)!.isFenceLine,
      ).toBe(true);
      expect(
        rawLineToBlockPath(realisticDocument as BlockNode[], 9)!.isFenceLine,
      ).toBe(true);
    });

    it("should mark table separator line 24", () => {
      expect(
        rawLineToBlockPath(realisticDocument as BlockNode[], 24)!
          .isSeparatorLine,
      ).toBe(true);
    });
  });
});

// ===================================================================
// Existing tests (updated for new fixture structure)
// ===================================================================

describe("lineToBlockPath (legacy — block index as line)", () => {
  it("should map line 1 to first block", () => {
    const editor = createTestEditor(simpleParagraphs as Descendant[]);
    expect(lineToBlockPath(editor, 1)).toEqual([0]);
  });

  it("should map line 2 to second block", () => {
    const editor = createTestEditor(simpleParagraphs as Descendant[]);
    expect(lineToBlockPath(editor, 2)).toEqual([1]);
  });

  it("should map line 3 to third block", () => {
    const editor = createTestEditor(simpleParagraphs as Descendant[]);
    expect(lineToBlockPath(editor, 3)).toEqual([2]);
  });

  it("should return null for line 0", () => {
    const editor = createTestEditor(simpleParagraphs as Descendant[]);
    expect(lineToBlockPath(editor, 0)).toBeNull();
  });

  it("should return null for line beyond document", () => {
    const editor = createTestEditor(simpleParagraphs as Descendant[]);
    expect(lineToBlockPath(editor, 10)).toBeNull();
  });
});

describe("findTextNodePath with simple paragraphs", () => {
  it("should find text at offset 0", () => {
    const editor = createTestEditor(simpleParagraphs as Descendant[]);
    const result = findTextNodePath(editor, [0], 0);
    expect(result).toEqual({
      path: [0, 0],
      offset: 0,
      absoluteOffset: 0,
    });
  });

  it("should find text at middle of paragraph", () => {
    const editor = createTestEditor(simpleParagraphs as Descendant[]);
    // "Hello world" - offset 6 is the "w"
    const result = findTextNodePath(editor, [0], 6);
    expect(result).toEqual({
      path: [0, 0],
      offset: 6,
      absoluteOffset: 0,
    });
  });

  it("should clamp to end of text", () => {
    const editor = createTestEditor(simpleParagraphs as Descendant[]);
    // "Hello world" has 11 chars, offset 100 should clamp to 11
    const result = findTextNodePath(editor, [0], 100);
    expect(result?.offset).toBe(11);
  });
});

describe("findTextNodePath with formatted text", () => {
  it("should find text in first text node", () => {
    const editor = createTestEditor(formattedParagraph as Descendant[]);
    // "Hello " is first text node (6 chars)
    const result = findTextNodePath(editor, [0], 3);
    expect(result).toEqual({
      path: [0, 0],
      offset: 3,
      absoluteOffset: 0,
    });
  });

  it("should find text in bold node", () => {
    const editor = createTestEditor(formattedParagraph as Descendant[]);
    // Structure: "Hello "(6) + "bold"(4) + " and "(5) + "italic"(6) + " text"(5)
    // Offset 7 is inside "bold" (at 'o')
    const result = findTextNodePath(editor, [0], 7);
    expect(result).toEqual({
      path: [0, 1], // second text node (bold)
      offset: 1, // 7 - 6 = 1
      absoluteOffset: 6,
    });
  });

  it("should find text in italic node", () => {
    const editor = createTestEditor(formattedParagraph as Descendant[]);
    // "Hello "(6) + "bold"(4) + " and "(5) = 15
    // "italic" starts at 15, offset 17 is 'a' in italic
    const result = findTextNodePath(editor, [0], 17);
    expect(result).toEqual({
      path: [0, 3], // fourth text node (italic)
      offset: 2, // 17 - 15 = 2
      absoluteOffset: 15,
    });
  });

  it("should find text at boundary between nodes", () => {
    const editor = createTestEditor(formattedParagraph as Descendant[]);
    // Offset 6 is exactly at the boundary after "Hello " (6 chars)
    const result = findTextNodePath(editor, [0], 6);
    expect(result).toEqual({
      path: [0, 0],
      offset: 6,
      absoluteOffset: 0,
    });
  });

  it("should find text just past boundary in next node", () => {
    const editor = createTestEditor(formattedParagraph as Descendant[]);
    const result = findTextNodePath(editor, [0], 7);
    expect(result).toEqual({
      path: [0, 1],
      offset: 1,
      absoluteOffset: 6,
    });
  });
});

describe("findTextNodePath with nested formatting", () => {
  it("should handle bold-italic text", () => {
    const editor = createTestEditor(nestedFormatting as Descendant[]);
    // "Normal "(7) + "bold "(5) + "bold-italic"(11) + " bold"(5) + " normal"(7)
    // Offset 14 is inside "bold-italic"
    const result = findTextNodePath(editor, [0], 14);
    expect(result).toEqual({
      path: [0, 2], // bold-italic node
      offset: 2, // 14 - 12 = 2
      absoluteOffset: 12,
    });
  });
});

describe("findTextNodePath with links", () => {
  it("should find text inside link element", () => {
    const editor = createTestEditor(paragraphWithLink as Descendant[]);
    // Structure: "Click "(6) + link["here"](4) + " for more"(9)
    const result = findTextNodePath(editor, [0], 7);
    expect(result).not.toBeNull();
    expect(result!.offset).toBe(1); // 7 - 6 = 1, inside "here"
  });
});

describe("findTextNodePath with empty paragraph", () => {
  it("should handle empty text node", () => {
    const editor = createTestEditor(emptyParagraph as Descendant[]);
    const result = findTextNodePath(editor, [0], 0);
    expect(result).toEqual({
      path: [0, 0],
      offset: 0,
      absoluteOffset: 0,
    });
  });

  it("should clamp any offset to 0 for empty paragraph", () => {
    const editor = createTestEditor(emptyParagraph as Descendant[]);
    const result = findTextNodePath(editor, [0], 10);
    expect(result?.offset).toBe(0);
  });
});

describe("columnToOffset", () => {
  it("should convert column 1 to offset 0", () => {
    expect(columnToOffset(11, 1)).toBe(0);
  });

  it("should convert column to correct offset", () => {
    expect(columnToOffset(11, 7)).toBe(6);
  });

  it("should clamp to text length", () => {
    expect(columnToOffset(5, 100)).toBe(5);
  });

  it("should handle column 0", () => {
    expect(columnToOffset(10, 0)).toBe(0);
  });
});

describe("fuzzyFind", () => {
  it("should find exact match", () => {
    expect(fuzzyFind("Hello world", "world", 6)).toBe(6);
  });

  it("should find closest match when preferred offset differs", () => {
    expect(fuzzyFind("Hello world", "world", 0)).toBe(6);
  });

  it("should find closest of multiple matches", () => {
    const text = "the cat and the dog and the bird";
    expect(fuzzyFind(text, "the", 15)).toBe(12);
  });

  it("should return -1 when not found", () => {
    expect(fuzzyFind("Hello world", "xyz", 0)).toBe(-1);
  });
});

describe("lineColumnToTextareaOffset", () => {
  const content = "Line 1\nLine 2\nLine 3";

  it("should return 0 for line 1 column 1", () => {
    expect(lineColumnToTextareaOffset(content, 1, 1)).toBe(0);
  });

  it("should calculate offset for line 2", () => {
    expect(lineColumnToTextareaOffset(content, 2, 3)).toBe(9);
  });

  it("should handle end of line", () => {
    expect(lineColumnToTextareaOffset(content, 1, 7)).toBe(6);
  });
});

describe("Integration: full navigation path with rawLineToBlockPath", () => {
  it("should navigate to code line in realistic document", () => {
    const editor = createTestEditor(realisticDocument as Descendant[]);

    // Target: "const y = 2;" at raw line 7, column 7 ('y')
    const mapping = rawLineToBlockPath(realisticDocument as BlockNode[], 7);
    expect(mapping).not.toBeNull();
    expect(mapping!.path).toEqual([2, 1]); // code_block[2] → code_line[1]

    const node = Node.get(editor as unknown as Node, mapping!.path);
    const text = Node.string(node);
    expect(text).toBe("const y = 2;");

    const offset = columnToOffset(text.length, 7);
    expect(offset).toBe(6); // 'y'
  });

  it("should navigate to list item in realistic document", () => {
    const editor = createTestEditor(realisticDocument as Descendant[]);

    // Target: "world" at raw line 12
    const mapping = rawLineToBlockPath(realisticDocument as BlockNode[], 12);
    expect(mapping).not.toBeNull();
    expect(mapping!.path).toEqual([4]); // block 4

    const node = Node.get(editor as unknown as Node, mapping!.path);
    const text = Node.string(node);
    expect(text).toBe("world");
  });

  it("should navigate to blockquote inner text", () => {
    const editor = createTestEditor(realisticDocument as Descendant[]);

    // Target: "this is a quote" at raw line 19
    const mapping = rawLineToBlockPath(realisticDocument as BlockNode[], 19);
    expect(mapping).not.toBeNull();
    expect(mapping!.path).toEqual([9, 0]); // blockquote → inner p

    const node = Node.get(editor as unknown as Node, mapping!.path);
    const text = Node.string(node);
    expect(text).toBe("this is a quote");
  });
});

describe("rawLineToBlockPath — embedded newlines", () => {
  it.each(embeddedNewlinesLineMap)(
    "line $rawLine → $description",
    ({ rawLine, blockIndex, path, expectedText }) => {
      const mapping = rawLineToBlockPath(
        embeddedNewlines as BlockNode[],
        rawLine,
      );
      expect(mapping).not.toBeNull();
      expect(mapping!.blockIndex).toBe(blockIndex);
      expect(mapping!.path).toEqual(path);

      const editor = createTestEditor(embeddedNewlines as Descendant[]);
      const node = Node.get(editor as unknown as Node, mapping!.path);
      expect(Node.string(node)).toBe(expectedText);
    },
  );

  it("blank lines between multi-line paragraphs return block mapping (Plate doesn't display separator)", () => {
    // Line 2 and 6 are blank separators — Plate doesn't display these separator lines.
    // Our implementation maps them to the preceding block with isSeparatorLine=true.
    // This is correct because the line belongs to the preceding block in the rendered view.
    const sep2 = rawLineToBlockPath(embeddedNewlines as BlockNode[], 2);
    expect(sep2).not.toBeNull();
    expect(sep2!.blockIndex).toBe(0);
    expect(sep2!.isSeparatorLine).toBe(true);

    const sep6 = rawLineToBlockPath(embeddedNewlines as BlockNode[], 6);
    expect(sep6).not.toBeNull();
    expect(sep6!.blockIndex).toBe(1);
    expect(sep6!.isSeparatorLine).toBe(true);

    // Line 10 is beyond the last block
    const sep10 = rawLineToBlockPath(embeddedNewlines as BlockNode[], 10);
    expect(sep10).not.toBeNull();
    expect(sep10!.blockIndex).toBe(2);
    expect(sep10!.isSeparatorLine).toBe(true);
  });
});

describe("markupPrefixLength", () => {
  it("returns correct prefix for headings", () => {
    expect(markupPrefixLength({ type: "h1", children: [] })).toBe(2); // "# "
    expect(markupPrefixLength({ type: "h2", children: [] })).toBe(3); // "## "
    expect(markupPrefixLength({ type: "h3", children: [] })).toBe(4); // "### "
    expect(markupPrefixLength({ type: "h4", children: [] })).toBe(5);
    expect(markupPrefixLength({ type: "h5", children: [] })).toBe(6);
    expect(markupPrefixLength({ type: "h6", children: [] })).toBe(7); // "###### "
  });

  it("returns correct prefix for unordered list items", () => {
    // Top-level: "- " or "* " = 2
    expect(
      markupPrefixLength({
        type: "p",
        indent: 1,
        listStyleType: "disc",
        children: [],
      }),
    ).toBe(2);
    // Nested (indent=2): "   - " = 5
    expect(
      markupPrefixLength({
        type: "p",
        indent: 2,
        listStyleType: "disc",
        children: [],
      }),
    ).toBe(5);
  });

  it("returns correct prefix for ordered list items", () => {
    // "1. " = 3
    expect(
      markupPrefixLength({
        type: "p",
        indent: 1,
        listStyleType: "decimal",
        children: [],
      }),
    ).toBe(3);
    // "2. " = 3
    expect(
      markupPrefixLength({
        type: "p",
        indent: 1,
        listStyleType: "decimal",
        listStart: 2,
        children: [],
      }),
    ).toBe(3);
    // "10. " = 4
    expect(
      markupPrefixLength({
        type: "p",
        indent: 1,
        listStyleType: "decimal",
        listStart: 10,
        children: [],
      }),
    ).toBe(4);
    // Nested: "   1. " = 6
    expect(
      markupPrefixLength({
        type: "p",
        indent: 2,
        listStyleType: "decimal",
        children: [],
      }),
    ).toBe(6);
  });

  it("returns correct prefix for checkbox list items", () => {
    // Unordered checkbox: "- [ ] " = 6 or "- [x] " = 6
    expect(
      markupPrefixLength({
        type: "p",
        indent: 1,
        listStyleType: "disc",
        checked: false,
        children: [],
      }),
    ).toBe(6); // "- [ ] "
    expect(
      markupPrefixLength({
        type: "p",
        indent: 1,
        listStyleType: "disc",
        checked: true,
        children: [],
      }),
    ).toBe(6); // "- [x] "
    // Todo style checkbox: "- [ ] " = 6 (same as disc)
    expect(
      markupPrefixLength({
        type: "p",
        indent: 1,
        listStyleType: "todo",
        checked: false,
        children: [],
      }),
    ).toBe(6); // "- [ ] "
    // Nested checkbox: "   - [ ] " = 9
    expect(
      markupPrefixLength({
        type: "p",
        indent: 2,
        listStyleType: "todo",
        checked: false,
        children: [],
      }),
    ).toBe(9); // "   - [ ] "
    // Nested checkbox: "   - [ ] " = 9
    expect(
      markupPrefixLength({
        type: "p",
        indent: 2,
        listStyleType: "disc",
        checked: false,
        children: [],
      }),
    ).toBe(9); // "   - [ ] "
  });

  it("returns correct prefix for blockquotes", () => {
    expect(markupPrefixLength({ type: "blockquote", children: [] })).toBe(2); // "> "
  });

  it("returns 0 for plain paragraphs", () => {
    expect(markupPrefixLength({ type: "p", children: [] })).toBe(0);
  });

  it("returns 0 for code blocks", () => {
    expect(markupPrefixLength({ type: "code_block", children: [] })).toBe(0);
  });
});

describe("markupPrefixLength integration: adjusted column → correct offset", () => {
  it("heading: raw column maps to correct Plate text offset", () => {
    // Raw markdown: "## Hello world"  →  "world" starts at raw column 10
    // Plate text: "Hello world"       →  "world" starts at offset 6
    const block: BlockNode = {
      type: "h2",
      children: [{ text: "Hello world" }],
    };
    const prefix = markupPrefixLength(block);
    expect(prefix).toBe(3); // "## "
    const rawColumn = 10;
    const adjustedColumn = rawColumn - prefix; // 7
    const offset = columnToOffset(11, adjustedColumn); // 6
    expect(offset).toBe(6);
  });

  it("list item: raw column maps to correct Plate text offset", () => {
    // Raw markdown: "- List item text"  →  "item" starts at raw column 8
    // Plate text: "List item text"     →  "item" starts at offset 5
    const block: BlockNode = {
      type: "p",
      indent: 1,
      listStyleType: "disc",
      children: [{ text: "List item text" }],
    };
    const prefix = markupPrefixLength(block);
    expect(prefix).toBe(2); // "- "
    const rawColumn = 8;
    const adjustedColumn = rawColumn - prefix; // 6
    const offset = columnToOffset(14, adjustedColumn); // 5
    expect(offset).toBe(5);
  });

  it("blockquote: raw column maps to correct Plate text offset", () => {
    // Raw markdown: "> A quoted sentence"  →  "quoted" starts at raw column 5
    // Plate text: "A quoted sentence"     →  "quoted" starts at offset 2
    const block: BlockNode = {
      type: "blockquote",
      children: [{ type: "p", children: [{ text: "A quoted sentence" }] }],
    };
    const prefix = markupPrefixLength(block);
    expect(prefix).toBe(2); // "> "
    const rawColumn = 5;
    const adjustedColumn = rawColumn - prefix; // 3
    const offset = columnToOffset(17, adjustedColumn); // 2
    expect(offset).toBe(2);
  });

  it("plain paragraph: no adjustment needed", () => {
    const block: BlockNode = {
      type: "p",
      children: [{ text: "Just plain text" }],
    };
    const prefix = markupPrefixLength(block);
    expect(prefix).toBe(0);
    const rawColumn = 6;
    const offset = columnToOffset(15, rawColumn - prefix); // 5
    expect(offset).toBe(5);
  });

  it("inline markup: prefix doesn't help but fuzzyFind corrects", () => {
    // Raw markdown: "Some **bold** text"  →  "bold" at raw column 8
    // Plate text: "Some bold text"       →  "bold" at offset 5
    // markupPrefixLength returns 0 for plain p, so adjusted column = 7, offset = 7 (wrong)
    // But fuzzyFind("Some bold text", "bold", 7) → 5 (correct)
    const plateText = "Some bold text";
    const wrongOffset = columnToOffset(plateText.length, 8); // 7
    const corrected = fuzzyFind(plateText, "bold", wrongOffset);
    expect(corrected).toBe(5);
  });
});

describe("rawLineToBlockPath — frontmatter with empty paragraphs and todos", () => {
  it.each(frontmatterEmptyParagraphsAndTodosLineMap)(
    "line $rawLine → $description",
    ({ rawLine, blockIndex, path, expectedText }) => {
      const mapping = rawLineToBlockPath(
        frontmatterEmptyParagraphsAndTodos as BlockNode[],
        rawLine,
      );
      expect(mapping).not.toBeNull();
      expect(mapping!.blockIndex).toBe(blockIndex);
      expect(mapping!.path).toEqual(path);

      const editor = createTestEditor(
        frontmatterEmptyParagraphsAndTodos as Descendant[],
      );
      const node = Node.get(editor as unknown as Node, mapping!.path);
      expect(Node.string(node)).toBe(expectedText);
    },
  );

  it("blank lines between frontmatter and todo items are correctly mapped", () => {
    // Based on the line counting trace:
    // Block 0 (hr): line 1
    // Block 1 (h2): lines 2-6 (5 embedded newlines)
    // Separator after block 1: line 8 (falls in h2 range [3,7])
    // Block 2 (empty p): line 9
    // Block 3 (empty p): line 10 (no separator - same list group with block 2)
    // Block 4 (empty p): line 11
    // Separator after block 4: line 12 (falls in block 4 range [11,11])
    // Block 5 (todo hello): line 13
    // etc.
    expect(
      rawLineToBlockPath(frontmatterEmptyParagraphsAndTodos as BlockNode[], 7),
    ).not.toBeNull(); // falls in block 1 (h2) range [3,7]
    expect(
      rawLineToBlockPath(frontmatterEmptyParagraphsAndTodos as BlockNode[], 9),
    ).not.toBeNull(); // block 2 (first empty p)
    expect(
      rawLineToBlockPath(frontmatterEmptyParagraphsAndTodos as BlockNode[], 10),
    ).not.toBeNull(); // block 3 (second empty p)
  });
});
