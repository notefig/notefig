import { describe, it, expect } from "vitest";
import { fuzzyFind } from "@/utils/navigation-utils";

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

  it("corrects an offset skewed by markdown markup", () => {
    // Raw markdown "Some **bold** text" puts "bold" at column 8, but the
    // rendered text "Some bold text" has it at offset 5 — fuzzyFind snaps
    // the skewed offset to the nearest real occurrence.
    expect(fuzzyFind("Some bold text", "bold", 7)).toBe(5);
  });
});
