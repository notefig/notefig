import { describe, expect, it } from "vitest";
import { arrived } from "./sync-editor";

describe("arrived", () => {
  it("is the stretch the new text added, wherever it went", () => {
    expect(arrived("Second paragraph.", "Typed Second paragraph.")).toEqual([0, 6]);
    expect(arrived("We start at nine.", "We start at nine. Lunch is at the venue.")).toEqual([17, 40]);
    expect(arrived("a rough review", "a short review")).toEqual([2, 7]);
    expect(arrived("", "A new one.")).toEqual([0, 10]);
  });

  it("is nothing when text was only taken away, or nothing changed", () => {
    expect(arrived("We start at nine sharp.", "We start at nine.")).toBeNull();
    expect(arrived("Same.", "Same.")).toBeNull();
  });
});
