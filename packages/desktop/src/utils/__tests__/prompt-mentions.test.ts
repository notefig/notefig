import { describe, expect, it } from "vitest";
import {
  applyMention,
  extractMentionTokens,
  getActiveMention,
} from "@/utils/prompt-mentions";

describe("getActiveMention", () => {
  it("detects @ at the start of the text", () => {
    expect(getActiveMention("@no", 3)).toEqual({ start: 0, query: "no" });
  });

  it("detects @ after whitespace, with the query up to the caret", () => {
    expect(getActiveMention("see @notes", 10)).toEqual({
      start: 4,
      query: "notes",
    });
    expect(getActiveMention("line\n@a", 7)).toEqual({ start: 5, query: "a" });
  });

  it("uses only text before the caret", () => {
    expect(getActiveMention("see @notes", 6)).toEqual({
      start: 4,
      query: "n",
    });
  });

  it("ignores mid-word @ (emails)", () => {
    expect(getActiveMention("mail me a@b", 11)).toBeNull();
  });

  it("closes once whitespace follows the @", () => {
    expect(getActiveMention("@notes done", 11)).toBeNull();
  });

  it("returns null with no @ before the caret", () => {
    expect(getActiveMention("hello", 5)).toBeNull();
    expect(getActiveMention("", 0)).toBeNull();
  });

  it("a bare @ yields an empty query", () => {
    expect(getActiveMention("say @", 5)).toEqual({ start: 4, query: "" });
  });
});

describe("applyMention", () => {
  it("replaces the active token and places the caret after a trailing space", () => {
    const result = applyMention(
      "see @no please",
      { start: 4, query: "no" },
      7,
      "notes.md",
    );
    expect(result.text).toBe("see @notes.md  please");
    expect(result.caret).toBe("see @notes.md ".length);
  });

  it("works at the end of the text", () => {
    const result = applyMention("@", { start: 0, query: "" }, 1, "a/b.md");
    expect(result.text).toBe("@a/b.md ");
    expect(result.caret).toBe(8);
  });
});

describe("extractMentionTokens", () => {
  it("extracts tokens at start, mid-text, and after newlines", () => {
    expect(extractMentionTokens("@a.md check with @docs/b.md\n@c.md")).toEqual([
      "a.md",
      "docs/b.md",
      "c.md",
    ]);
  });

  it("ignores mid-word @ and dedupes", () => {
    expect(extractMentionTokens("a@b.md and @x.md plus @x.md")).toEqual([
      "x.md",
    ]);
  });

  it("adds punctuation-stripped variants", () => {
    expect(extractMentionTokens("see @notes.md.")).toEqual([
      "notes.md.",
      "notes.md",
    ]);
  });

  it("returns [] when nothing matches", () => {
    expect(extractMentionTokens("no mentions here")).toEqual([]);
    expect(extractMentionTokens("@ alone")).toEqual([]);
  });
});
