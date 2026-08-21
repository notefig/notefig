import { describe, expect, it } from "vitest";
import {
  applyMention,
  extractMentionPaths,
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

describe("extractMentionPaths", () => {
  const workspace = (...paths: string[]) => {
    const set = new Set(paths);
    return (candidate: string) => set.has(candidate);
  };

  it("extracts mentions at start, mid-text, and after newlines", () => {
    const isPath = workspace("a.md", "docs/b.md", "c.md");
    expect(
      extractMentionPaths("@a.md check with @docs/b.md\n@c.md", isPath),
    ).toEqual(["a.md", "docs/b.md", "c.md"]);
  });

  it("ignores mid-word @, unresolvable tokens, and dedupes", () => {
    const isPath = workspace("b.md", "x.md");
    expect(
      extractMentionPaths("a@b.md and @x.md plus @x.md or @nope.md", isPath),
    ).toEqual(["x.md"]);
  });

  it("resolves paths containing spaces, longest match first", () => {
    const isPath = workspace("my file.md", "my");
    expect(
      extractMentionPaths("read @my file.md before lunch", isPath),
    ).toEqual(["my file.md"]);
    // Falls back to the shorter file when the long candidate isn't one.
    expect(extractMentionPaths("read @my notes", workspace("my"))).toEqual([
      "my",
    ]);
  });

  it("does not run a mention past its line", () => {
    const isPath = workspace("my file.md");
    expect(extractMentionPaths("@my\nfile.md", isPath)).toEqual([]);
  });

  it("strips trailing punctuation per candidate", () => {
    const isPath = workspace("notes.md", "my file.md");
    expect(extractMentionPaths("see @notes.md.", isPath)).toEqual(["notes.md"]);
    expect(extractMentionPaths("(read @my file.md!)", isPath)).toEqual([
      "my file.md",
    ]);
  });

  it("returns [] when nothing matches", () => {
    expect(extractMentionPaths("no mentions here", () => true)).toEqual([]);
    expect(extractMentionPaths("@ alone", () => true)).toEqual([]);
  });
});
