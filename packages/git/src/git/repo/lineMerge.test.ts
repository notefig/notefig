import { lineMerge } from "./lineMerge";

describe("lineMerge", () => {
  it("keeps a lone CR, U+2028 and U+2029 in lines neither side changed", () => {
    const base = "one\nkeep\r this\nand this\nand this\nlast\n";
    const ours = base.replace("one\n", "ONE\n");
    const theirs = base.replace("last\n", "LAST\n");
    const { content, conflicted } = lineMerge(base, ours, theirs);
    expect(conflicted).toBe(false);
    expect(content).toBe("ONE\nkeep\r this\nand this\nand this\nLAST\n");
  });

  it("round-trips text with CRLF and no final newline", () => {
    const base = "a\r\nb\r\nc";
    const ours = "A\r\nb\r\nc";
    const theirs = "a\r\nb\r\nC";
    expect(lineMerge(base, ours, theirs)).toEqual({
      content: "A\r\nb\r\nC",
      conflicted: false,
    });
  });
});
