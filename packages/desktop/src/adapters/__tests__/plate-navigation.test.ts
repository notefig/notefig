import { describe, it, expect } from "vitest";
import { Node, type Descendant, Element, Text } from "slate";
import {
  fuzzyFind,
  lineColumnToTextareaOffset,
  columnToOffset,
} from "@/utils/navigation-utils";

import {
  simpleParagraphs,
  headingsAndParagraphs,
  formattedParagraph,
  nestedFormatting,
  mixedContent,
  emptyParagraph,
  paragraphWithLink,
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
 * Simulates lineToBlockPath logic - maps 1-indexed line to block path.
 * Each top-level block is treated as a "line".
 *
 * This is a simplified version that only considers top-level children.
 * The actual implementation in editor-store.ts uses Editor.nodes with mode: "highest".
 */
function lineToBlockPath(editor: MockEditor, line: number): [number] | null {
  // Get all top-level children that are blocks
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

describe("lineToBlockPath", () => {
  it("should map line 1 to first block", () => {
    const editor = createTestEditor(simpleParagraphs);
    expect(lineToBlockPath(editor, 1)).toEqual([0]);
  });

  it("should map line 2 to second block", () => {
    const editor = createTestEditor(simpleParagraphs);
    expect(lineToBlockPath(editor, 2)).toEqual([1]);
  });

  it("should map line 3 to third block", () => {
    const editor = createTestEditor(simpleParagraphs);
    expect(lineToBlockPath(editor, 3)).toEqual([2]);
  });

  it("should return null for line 0", () => {
    const editor = createTestEditor(simpleParagraphs);
    expect(lineToBlockPath(editor, 0)).toBeNull();
  });

  it("should return null for line beyond document", () => {
    const editor = createTestEditor(simpleParagraphs);
    expect(lineToBlockPath(editor, 10)).toBeNull();
  });

  it("should handle headings as separate lines", () => {
    const editor = createTestEditor(headingsAndParagraphs);
    // Line 1 = h1, Line 2 = p, Line 3 = h2, Line 4 = p
    expect(lineToBlockPath(editor, 1)).toEqual([0]); // h1
    expect(lineToBlockPath(editor, 3)).toEqual([2]); // h2
  });

  it("should handle mixed content", () => {
    const editor = createTestEditor(mixedContent);
    // Line 1 = h1, Line 2 = p, Line 3 = ul, Line 4 = blockquote, Line 5 = p
    expect(lineToBlockPath(editor, 1)).toEqual([0]); // h1
    expect(lineToBlockPath(editor, 2)).toEqual([1]); // p with formatting
    expect(lineToBlockPath(editor, 3)).toEqual([2]); // ul (whole list is one block)
    expect(lineToBlockPath(editor, 4)).toEqual([3]); // blockquote
    expect(lineToBlockPath(editor, 5)).toEqual([4]); // final p
  });
});

describe("findTextNodePath with simple paragraphs", () => {
  it("should find text at offset 0", () => {
    const editor = createTestEditor(simpleParagraphs);
    const result = findTextNodePath(editor, [0], 0);
    expect(result).toEqual({
      path: [0, 0],
      offset: 0,
      absoluteOffset: 0,
    });
  });

  it("should find text at middle of paragraph", () => {
    const editor = createTestEditor(simpleParagraphs);
    // "Hello world" - offset 6 is the "w"
    const result = findTextNodePath(editor, [0], 6);
    expect(result).toEqual({
      path: [0, 0],
      offset: 6,
      absoluteOffset: 0,
    });
  });

  it("should clamp to end of text", () => {
    const editor = createTestEditor(simpleParagraphs);
    // "Hello world" has 11 chars, offset 100 should clamp to 11
    const result = findTextNodePath(editor, [0], 100);
    expect(result?.offset).toBe(11);
  });
});

describe("findTextNodePath with formatted text", () => {
  it("should find text in first text node", () => {
    const editor = createTestEditor(formattedParagraph);
    // "Hello " is first text node (6 chars)
    const result = findTextNodePath(editor, [0], 3);
    expect(result).toEqual({
      path: [0, 0],
      offset: 3,
      absoluteOffset: 0,
    });
  });

  it("should find text in bold node", () => {
    const editor = createTestEditor(formattedParagraph);
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
    const editor = createTestEditor(formattedParagraph);
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
    const editor = createTestEditor(formattedParagraph);
    // Offset 6 is exactly at the boundary after "Hello " (6 chars)
    // With `<=` comparison, offset 6 stays in the first text node (at its end)
    // This is correct behavior - we're at the end of "Hello ", not start of "bold"
    const result = findTextNodePath(editor, [0], 6);
    expect(result).toEqual({
      path: [0, 0], // Still in first text node (at its boundary)
      offset: 6, // At the end of "Hello "
      absoluteOffset: 0,
    });
  });

  it("should find text just past boundary in next node", () => {
    const editor = createTestEditor(formattedParagraph);
    // Offset 7 is one past the boundary, inside "bold"
    const result = findTextNodePath(editor, [0], 7);
    expect(result).toEqual({
      path: [0, 1], // Second text node (bold)
      offset: 1, // 7 - 6 = 1
      absoluteOffset: 6,
    });
  });
});

describe("findTextNodePath with nested formatting", () => {
  it("should handle bold-italic text", () => {
    const editor = createTestEditor(nestedFormatting);
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
    const editor = createTestEditor(paragraphWithLink);
    // Structure: "Click "(6) + link["here"](4) + " for more"(9)
    // Link is an element, not just a text node - need to traverse into it
    // The link's text "here" should be found
    const result = findTextNodePath(editor, [0], 7);

    // This depends on how Node.texts traverses inline elements
    // It should find the text inside the link
    expect(result).not.toBeNull();
    expect(result!.offset).toBe(1); // 7 - 6 = 1, inside "here"
  });
});

describe("findTextNodePath with empty paragraph", () => {
  it("should handle empty text node", () => {
    const editor = createTestEditor(emptyParagraph);
    const result = findTextNodePath(editor, [0], 0);
    expect(result).toEqual({
      path: [0, 0],
      offset: 0,
      absoluteOffset: 0,
    });
  });

  it("should clamp any offset to 0 for empty paragraph", () => {
    const editor = createTestEditor(emptyParagraph);
    const result = findTextNodePath(editor, [0], 10);
    expect(result?.offset).toBe(0);
  });
});

describe("columnToOffset", () => {
  it("should convert column 1 to offset 0", () => {
    expect(columnToOffset(11, 1)).toBe(0); // "Hello world"
  });

  it("should convert column to correct offset", () => {
    expect(columnToOffset(11, 7)).toBe(6); // "Hello world" - column 7 is 'w'
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
    // "world" is at index 6, but we prefer 0 - should still find it at 6
    expect(fuzzyFind("Hello world", "world", 0)).toBe(6);
  });

  it("should find closest of multiple matches", () => {
    const text = "the cat and the dog and the bird";
    // "the" appears at 0, 12, 24
    // Preferred offset 15 is closest to 12
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
    // "Line 1\n" = 7 chars, then column 3 = offset 2
    expect(lineColumnToTextareaOffset(content, 2, 3)).toBe(9);
  });

  it("should handle end of line", () => {
    // "Line 1" has 6 chars, column 7 should clamp to 6
    expect(lineColumnToTextareaOffset(content, 1, 7)).toBe(6);
  });
});

describe("Integration: full navigation path", () => {
  it("should navigate to specific word in formatted text", () => {
    const editor = createTestEditor(formattedParagraph);
    // Structure: "Hello "(6) + "bold"(4) + " and "(5) + "italic"(6) + " text"(5)
    // Cumulative: 0-5, 6-9, 10-14, 15-20, 21-25
    // Target: 'i' in "italic" = offset 15

    // Step 1: Get block path for line 1
    const blockPath = lineToBlockPath(editor, 1);
    expect(blockPath).toEqual([0]);

    // Step 2: Calculate offset from column
    const blockText = Node.string(
      Node.get(editor as unknown as Node, blockPath!),
    );
    expect(blockText).toBe("Hello bold and italic text");

    // Column 16 (1-indexed) = offset 15 (0-indexed)
    const offset = columnToOffset(blockText.length, 16);
    expect(offset).toBe(15);

    // Step 3: Find text node path
    // Offset 15 is exactly at the boundary: " and " ends at 15, "italic" starts at 15
    // With `<=` comparison, offset 15 stays in " and " node (at its end)
    const textPath = findTextNodePath(editor, blockPath!, offset);
    expect(textPath).not.toBeNull();
    expect(textPath!.path).toEqual([0, 2]); // " and " text node (at boundary)
    expect(textPath!.offset).toBe(5); // end of " and "
    expect(textPath!.absoluteOffset).toBe(10); // " and " starts at offset 10

    // To get into "italic", we need offset 16
    const textPathInItalic = findTextNodePath(editor, blockPath!, 16);
    expect(textPathInItalic!.path).toEqual([0, 3]); // italic text node
    expect(textPathInItalic!.offset).toBe(1); // second char of "italic"
  });

  it("should navigate to text in heading", () => {
    const editor = createTestEditor(headingsAndParagraphs);
    // Target: "Title" in "Main Title"
    // Line 1, column 6 should be at 'T' in Title

    const blockPath = lineToBlockPath(editor, 1);
    expect(blockPath).toEqual([0]);

    const blockText = Node.string(
      Node.get(editor as unknown as Node, blockPath!),
    );
    expect(blockText).toBe("Main Title");

    const offset = columnToOffset(blockText.length, 6);
    expect(offset).toBe(5);

    const textPath = findTextNodePath(editor, blockPath!, offset);
    expect(textPath!.offset).toBe(5);
  });
});
