import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";
import { getLocalizedCommandKeywords } from "../command-keywords";

function createTranslator(returnValue: unknown): TFunction {
  return ((key: string) => {
    if (key === "commandKeywords.toggleTheme") {
      return returnValue;
    }
    return [];
  }) as TFunction;
}

describe("getLocalizedCommandKeywords", () => {
  it("returns localized keywords when translator returns a string array", () => {
    const t = createTranslator(["tema", "claro", "oscuro"]);

    const result = getLocalizedCommandKeywords(
      t,
      "commandKeywords.toggleTheme",
    );

    expect(result).toEqual(["tema", "claro", "oscuro"]);
  });

  it("falls back to English keywords when translator result is invalid", () => {
    const t = createTranslator("commandKeywords.toggleTheme");

    const result = getLocalizedCommandKeywords(
      t,
      "commandKeywords.toggleTheme",
    );

    expect(result).toContain("theme");
    expect(result).toContain("light");
    expect(result).toContain("dark");
  });

  it("returns empty array when neither localized nor English value is a string array", () => {
    const t = createTranslator(["valid"]);

    const result = getLocalizedCommandKeywords(t, "commandKeywords.missingKey");

    expect(result).toEqual([]);
  });
});
