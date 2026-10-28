import { describe, it, expect } from "vitest";
import { diffInfo, diffOfInfo, parseDiffSides } from "../syntax";

describe("diff block syntax", () => {
  it("reads the diff from the info string's words after the language", () => {
    expect(diffOfInfo("ts diff=src/app.ts")).toBe("src/app.ts");
    expect(diffOfInfo("python diff")).toBe("");
    expect(diffOfInfo("ts  title=x  diff")).toBe("");
    expect(diffOfInfo("ts")).toBeNull();
    // The unified-diff language, not a diff block.
    expect(diffOfInfo("diff")).toBeNull();
    expect(diffOfInfo("ts different")).toBeNull();
  });

  it("writes it back the way it reads", () => {
    for (const diff of ["src/app.ts", "", null]) expect(diffOfInfo(`ts${diffInfo(diff)}`)).toBe(diff);
  });

  it("splits the body at the separator, each side ending in a newline", () => {
    expect(parseDiffSides("const a = 1;\nconst b = 2;\n=======\nconst a = 1;\nconst b = 3;")).toEqual({
      before: "const a = 1;\nconst b = 2;\n",
      after: "const a = 1;\nconst b = 3;\n",
    });
  });

  it("keeps a trailing blank line, a change of its own", () => {
    expect(parseDiffSides("a\n=======\na\n")).toEqual({ before: "a\n", after: "a\n\n" });
  });

  it("splits at the first separator; the side before it may be empty", () => {
    expect(parseDiffSides("=======\nTitle\n=======")).toEqual({ before: "", after: "Title\n=======\n" });
  });

  it("is no diff without a separator", () => {
    expect(parseDiffSides("const a = 1;")).toBeNull();
  });
});
