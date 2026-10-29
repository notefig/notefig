import { describe, it, expect } from "vitest";
import { diffInfo, isDiffInfo } from "../syntax";

describe("diff block syntax", () => {
  it("is marked by `diff` among the info string's words after the language", () => {
    expect(isDiffInfo("ts diff")).toBe(true);
    expect(isDiffInfo("ts  title=x  diff")).toBe(true);
    expect(isDiffInfo("ts")).toBe(false);
    // The unified-diff language, not a diff block.
    expect(isDiffInfo("diff")).toBe(false);
    expect(isDiffInfo("ts different")).toBe(false);
  });

  it("writes it back the way it reads", () => {
    for (const diff of [true, false]) expect(isDiffInfo(`ts${diffInfo(diff)}`)).toBe(diff);
  });
});
