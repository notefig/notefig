import { describe, it, expect } from "vitest";
import {
  resolveLineColumn,
  fullTextOffsetToTextOffset,
} from "@/components/editor/editor-position";

const mockDoc = (text: string) => {
  const size = text.length + 2; // doc start/end boundaries
  return { content: { size } };
};

describe("resolveLineColumn", () => {
  it("returns position 1 for line 1 column 1 in empty doc", () => {
    expect(resolveLineColumn(mockDoc(""), "", 1, 1)).toBe(1);
  });

  it("returns position 1 for line 1 column 1", () => {
    expect(resolveLineColumn(mockDoc("hello"), "hello", 1, 1)).toBe(1);
  });

  it("returns position after first char for line 1 column 2", () => {
    expect(resolveLineColumn(mockDoc("hello"), "hello", 1, 2)).toBe(2);
  });

  it("returns end of text for line 1 column 6 (len 5)", () => {
    expect(resolveLineColumn(mockDoc("hello"), "hello", 1, 6)).toBe(6);
  });

  it("maps column to line 2 correctly", () => {
    // "Line 1\nLine 2": pos 1 + 6(L) + 1(nl) + 3(Lin) = 11
    expect(
      resolveLineColumn(mockDoc("Line 1\nLine 2"), "Line 1\nLine 2", 2, 4),
    ).toBe(11);
  });

  it("maps line 2 column 1 to start of second line", () => {
    // pos 1 + 6(L) + 1(nl) + 0 = 8 (start of second line)
    expect(
      resolveLineColumn(mockDoc("Line 1\nLine 2"), "Line 1\nLine 2", 2, 1),
    ).toBe(8);
  });

  it("clamps column beyond line length", () => {
    // "ab" has length 2, column 10 should clamp to end of line = pos 3
    expect(resolveLineColumn(mockDoc("ab"), "ab", 1, 10)).toBe(3);
  });

  it("handles multi-line with empty lines", () => {
    const text = "first\n\nthird";
    // line 1: first (5 chars)
    // line 2 (empty)
    // line 3: third
    // pos of line 2 column 1 = 1 + 5 + 1 (newline) = 7
    expect(resolveLineColumn(mockDoc(text), text, 2, 1)).toBe(7);
    // pos of line 3 column 2 = 1 + 5 + 1 + 0 + 1 = 8, then + 1 = 9 (col 2 of "third")
    expect(resolveLineColumn(mockDoc(text), text, 3, 2)).toBe(9);
  });

  it("handles line numbers beyond document size", () => {
    const text = "only one line";
    // doc size = 13 + 2 = 15, position clamps to 15
    expect(resolveLineColumn(mockDoc(text), text, 5, 1)).toBe(15);
  });

  it("handles column 0 gracefully", () => {
    // column 0 is below 1-indexed, should be treated as column 1
    expect(resolveLineColumn(mockDoc("hello"), "hello", 1, 0)).toBe(1);
  });

  it("handles line 0 gracefully", () => {
    // line 0 is below 1-indexed, resolves to start of doc (clamped above)
    expect(resolveLineColumn(mockDoc("hello"), "hello", 0, 1)).toBe(1);
  });

  it("clamps position to doc content size", () => {
    const text = "abc";
    // doc size is text.length + 2 = 5, max pos is 5
    expect(resolveLineColumn(mockDoc(text), text, 1, 4)).toBe(4);
  });

  it("handles fenced code block text", () => {
    const text = "```\nconst x = 1;\n```";
    // "const x = 1;" starts at line 2 column 1
    const pos = resolveLineColumn(mockDoc(text), text, 2, 1);
    expect(pos).toBe(5); // 1 + 3 + 1(nl) = 5
  });

  it("handles heading with markdown prefix", () => {
    // resolveLineColumn is column-unaware of markdown syntax — it treats
    // "#" as literal text. This is correct; the caller handles prefix offset.
    const text = "## Heading";
    expect(resolveLineColumn(mockDoc(text), text, 1, 1)).toBe(1);
    expect(resolveLineColumn(mockDoc(text), text, 1, 3)).toBe(3);
  });
});

describe("fullTextOffsetToTextOffset", () => {
  // Maps offsets in the "\n"-separated full text (textBetween output) to
  // offsets in the concatenated text-node stream — the Bug #16 seam.

  it("is identity when there are no separators before the offset", () => {
    expect(fullTextOffsetToTextOffset("hello", 3)).toBe(3);
    expect(fullTextOffsetToTextOffset("hello\nworld", 4)).toBe(4);
  });

  it("discounts one separator per preceding newline", () => {
    // offset 6 points at "w" in "hello\nworld" → text-stream offset 5
    expect(fullTextOffsetToTextOffset("hello\nworld", 6)).toBe(5);
  });

  it("discounts multiple separators", () => {
    // "a\nb\nc": offset 4 points at "c" → stream offset 2
    expect(fullTextOffsetToTextOffset("a\nb\nc", 4)).toBe(2);
  });

  it("handles offset 0", () => {
    expect(fullTextOffsetToTextOffset("a\nb", 0)).toBe(0);
  });

  it("counts a separator exactly at the boundary", () => {
    // offset pointing at the "\n" itself: separators strictly before it
    expect(fullTextOffsetToTextOffset("ab\ncd", 2)).toBe(2);
    expect(fullTextOffsetToTextOffset("ab\ncd", 3)).toBe(2);
  });
});
