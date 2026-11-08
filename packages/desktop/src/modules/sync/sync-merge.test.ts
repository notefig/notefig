import { describe, expect, it } from "vitest";
import { mergeMarkdown, splitUnits } from "./sync-merge";

const units = (source: string) => splitUnits(source).map((unit) => unit.text);
const base = "# Title\n\nFirst paragraph here.\n\nSecond paragraph here.\n";

describe("splitUnits", () => {
  it("cuts at paragraphs, list items, sub-items, table rows and code blocks", () => {
    const source =
      "---\ntitle: a\n---\n# H\n\ntext\nwrapped\n\n- one\n  - sub\n- two\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n```js\nx\n\ny\n```\n";
    expect(units(source)).toEqual([
      "---\ntitle: a\n---",
      "# H",
      "text\nwrapped",
      "- one",
      "  - sub",
      "- two",
      "| a | b |\n| - | - |",
      "| 1 | 2 |",
      "```js\nx\n\ny\n```",
    ]);
  });

  it("loses no bytes", () => {
    const source = "<!-- note -->\n\n_x_  \nwrapped\n\n\n* a\n* b\n";
    expect(splitUnits(source).map((unit) => unit.text + unit.gap).join("")).toBe(source);
  });
});

describe("mergeMarkdown", () => {
  it("takes both sides' changes to different units, and keeps untouched bytes", () => {
    const start = "_odd_  \nwrapped\n\nFirst.\n\nSecond.\n";
    const merged = mergeMarkdown(start, start.replace("First.", "First, mine."), start.replace("Second.", "Second, theirs."));
    expect(merged).toEqual({ text: "_odd_  \nwrapped\n\nFirst, mine.\n\nSecond, theirs.\n", overwritten: [] });
  });

  it("merges words inside one unit when the edits don't touch", () => {
    const merged = mergeMarkdown(
      "One two three four five.\n",
      "One TWO three four five.\n",
      "One two three four FIVE.\n",
    );
    expect(merged).toEqual({ text: "One TWO three four FIVE.\n", overwritten: [] });
  });

  it("gives colliding edits to the holder and returns the loser's text", () => {
    const merged = mergeMarkdown(base, base.replace("First", "Mine"), base.replace("First", "Theirs"));
    expect(merged.text).toBe("# Title\n\nTheirs paragraph here.\n\nSecond paragraph here.\n");
    expect(merged.overwritten).toEqual(["Mine paragraph here."]);
  });

  it("keeps an edit against a delete, from either side", () => {
    const deleted = "# Title\n\nSecond paragraph here.\n";
    const edited = base.replace("First", "Edited");
    expect(mergeMarkdown(base, edited, deleted)).toEqual({ text: edited, overwritten: [] });
    expect(mergeMarkdown(base, deleted, edited)).toEqual({ text: edited, overwritten: [] });
  });

  it("inserts from both sides, and appends with the blank line a new last unit needs", () => {
    const merged = mergeMarkdown("One.\n", "One.\n\nMine.\n", "Zero.\n\nOne.\n");
    expect(merged).toEqual({ text: "Zero.\n\nOne.\n\nMine.\n", overwritten: [] });
  });

  it("merges list items separately, keeping tight lists tight", () => {
    const list = "- a\n- b\n- c\n";
    expect(mergeMarkdown(list, "- a!\n- b\n- c\n", "- a\n- b\n- c!\n").text).toBe("- a!\n- b\n- c!\n");
  });

  it("takes one side when the same change was made on both", () => {
    const same = base.replace("First", "Same");
    expect(mergeMarkdown(base, same, same)).toEqual({ text: same, overwritten: [] });
  });
});
