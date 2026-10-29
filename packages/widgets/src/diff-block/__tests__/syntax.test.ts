import { describe, it, expect } from "vitest";
import { diffInfo, hasDiffBlock, isDiffInfo } from "../syntax";

describe("diff block syntax", () => {
  it("is marked by `diff` among the info string's words after the language", () => {
    expect(isDiffInfo("ts diff")).toBe(true);
    expect(isDiffInfo("ts  title=x  diff")).toBe(true);
    expect(isDiffInfo("ts")).toBe(false);
    // The unified-diff language, not a diff block.
    expect(isDiffInfo("diff")).toBe(false);
    expect(isDiffInfo("ts different")).toBe(false);
  });

  it("finds a diff block in markdown, and only one", () => {
    expect(hasDiffBlock("See:\n\n```ts diff\n--- a.ts\n+++ a.ts\n```\n")).toBe(true);
    expect(hasDiffBlock("  ~~~ts diff\n~~~")).toBe(true);
    expect(hasDiffBlock("```ts\nconst diff = 1;\n```\n```diff\n-a\n+b\n```")).toBe(false);
    expect(hasDiffBlock("Inline ```ts diff``` is not a fence.")).toBe(false);
  });

  it("writes it back the way it reads", () => {
    for (const diff of [true, false]) expect(isDiffInfo(`ts${diffInfo(diff)}`)).toBe(diff);
  });
});
