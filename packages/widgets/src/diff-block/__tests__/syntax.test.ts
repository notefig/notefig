import { describe, it, expect } from "vitest";
import { diffTarget, isDiffLanguage, parseDiffBlock } from "../syntax";

describe("diff block syntax", () => {
  it("is a code block whose language starts with diff:", () => {
    expect(isDiffLanguage("diff:ts")).toBe(true);
    expect(isDiffLanguage("diff")).toBe(false);
    expect(isDiffLanguage("ts")).toBe(false);
    expect(isDiffLanguage(null)).toBe(false);
  });

  it("names a path when the target has a dot or a slash, a language otherwise", () => {
    expect(diffTarget("diff:src/app.ts")).toEqual({ path: "src/app.ts", language: null });
    expect(diffTarget("diff:Makefile.am")).toEqual({ path: "Makefile.am", language: null });
    expect(diffTarget("diff:python")).toEqual({ path: null, language: "python" });
    expect(diffTarget("diff:")).toEqual({ path: null, language: null });
  });

  it("splits the body at the separator, each side ending in a newline", () => {
    expect(parseDiffBlock("diff:ts", "const a = 1;\nconst b = 2;\n=======\nconst a = 1;\nconst b = 3;")).toEqual({
      path: null,
      language: "ts",
      before: "const a = 1;\nconst b = 2;\n",
      after: "const a = 1;\nconst b = 3;\n",
    });
  });

  it("keeps a trailing blank line, a change of its own", () => {
    expect(parseDiffBlock("diff:ts", "a\n=======\na\n")).toMatchObject({ before: "a\n", after: "a\n\n" });
  });

  it("splits at the first separator; the side before it may be empty", () => {
    expect(parseDiffBlock("diff:md", "=======\nTitle\n=======")).toMatchObject({
      before: "",
      after: "Title\n=======\n",
    });
  });

  it("is no diff without a separator, or for another language", () => {
    expect(parseDiffBlock("diff:ts", "const a = 1;")).toBeNull();
    expect(parseDiffBlock("ts", "a\n=======\nb")).toBeNull();
  });
});
