import { describe, it, expect } from "vitest";
import { normalizeImageName } from "@/components/editor/editor-store";

describe("normalizeImageName", () => {
  it("replaces spaces with hyphens", () => {
    expect(normalizeImageName("image (1).jpg")).toBe("image-1.jpg");
  });

  it("collapses multiple spaces into a single hyphen", () => {
    expect(normalizeImageName("my   photo.png")).toBe("my-photo.png");
  });

  it("removes parentheses", () => {
    expect(normalizeImageName("photo(1).png")).toBe("photo1.png");
  });

  it("handles names with both spaces and parentheses", () => {
    expect(normalizeImageName("Screen Shot (2).png")).toBe("Screen-Shot-2.png");
  });

  it("passes through names with no special chars", () => {
    expect(normalizeImageName("photo.png")).toBe("photo.png");
  });

  it("passes through already-normalized names", () => {
    expect(normalizeImageName("pasted-12345.png")).toBe("pasted-12345.png");
  });
});
