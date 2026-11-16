import { describe, expect, it } from "vitest";
import { mergeMarkdown, splitUnits } from "./sync-merge";

const units = async (source: string) => (await splitUnits(source)).map((unit) => unit.text);
const base = "# Title\n\nFirst paragraph here.\n\nSecond paragraph here.\n";

describe("splitUnits", () => {
  it("cuts at paragraphs, list items, sub-items, table rows and code blocks", async () => {
    const source =
      "---\ntitle: a\n---\n# H\n\ntext\nwrapped\n\n- one\n  - sub\n- two\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n```js\nx\n\ny\n```\n";
    expect(await units(source)).toEqual([
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

  it("loses no bytes", async () => {
    const source = "\n\n<!-- note -->\n\n_x_  \nwrapped\n\n\n* a\n* b\n> quote\n";
    expect((await splitUnits(source)).map((unit) => unit.text + unit.gap).join("")).toBe(source);
  });
});

describe("mergeMarkdown", () => {
  it("takes both sides' changes to different units, and keeps untouched bytes", async () => {
    const start = "_odd_  \nwrapped\n\nFirst.\n\nSecond.\n";
    const merged = await mergeMarkdown(start, start.replace("First.", "First, mine."), start.replace("Second.", "Second, theirs."));
    expect(merged).toEqual({ text: "_odd_  \nwrapped\n\nFirst, mine.\n\nSecond, theirs.\n", overwritten: [] });
  });

  it("takes an edit and an insert next to it", async () => {
    const mine = base.replace("First paragraph here.", "First paragraph here.\n\nAdded by me.");
    const theirs = base.replace("First", "Edited first");
    expect(await mergeMarkdown(base, mine, theirs)).toEqual({
      text: "# Title\n\nEdited first paragraph here.\n\nAdded by me.\n\nSecond paragraph here.\n",
      overwritten: [],
    });
    expect((await mergeMarkdown(base, theirs, mine)).text).toBe("# Title\n\nEdited first paragraph here.\n\nAdded by me.\n\nSecond paragraph here.\n");
  });

  it("merges words inside one unit when the edits don't touch", async () => {
    const merged = await mergeMarkdown("One two three four five.\n", "One TWO three four five.\n", "One two three four FIVE.\n");
    expect(merged).toEqual({ text: "One TWO three four FIVE.\n", overwritten: [] });
  });

  it("gives colliding edits to the holder and returns ours", async () => {
    const merged = await mergeMarkdown(base, base.replace("First", "Mine"), base.replace("First", "Theirs"));
    expect(merged.text).toBe("# Title\n\nTheirs paragraph here.\n\nSecond paragraph here.\n");
    expect(merged.overwritten).toEqual(["Mine paragraph here."]);
  });

  it("returns only the units ours changed when a collision takes a stretch", async () => {
    const mine = base.replace("First paragraph here.", "Mine.\n\nAlso mine.");
    const theirs = base.replace("First paragraph here.", "Theirs.");
    const merged = await mergeMarkdown(base, mine, theirs);
    expect(merged.text).toBe("# Title\n\nTheirs.\n\nSecond paragraph here.\n");
    expect(merged.overwritten).toEqual(["Mine.\n\nAlso mine."]);
  });

  it("keeps an edit against a delete, from either side", async () => {
    const deleted = "# Title\n\nSecond paragraph here.\n";
    const edited = base.replace("First", "Edited");
    expect(await mergeMarkdown(base, edited, deleted)).toEqual({ text: edited, overwritten: [] });
    expect(await mergeMarkdown(base, deleted, edited)).toEqual({ text: edited, overwritten: [] });
  });

  it("keeps inserts at one spot from both sides, the holder's first", async () => {
    const merged = await mergeMarkdown("One.\n\nTwo.\n", "One.\n\nMine.\n\nTwo.\n", "One.\n\nTheirs.\n\nTwo.\n");
    expect(merged).toEqual({ text: "One.\n\nTheirs.\n\nMine.\n\nTwo.\n", overwritten: [] });
  });

  it("appends from both sides with the blank line a new last unit needs", async () => {
    const merged = await mergeMarkdown("One.\n", "One.\n\nMine.\n", "Zero.\n\nOne.\n");
    expect(merged).toEqual({ text: "Zero.\n\nOne.\n\nMine.\n", overwritten: [] });
  });

  it("merges list items separately, keeping a tight list tight", async () => {
    const list = "- a\n- b\n- c\n";
    expect((await mergeMarkdown(list, "- a!\n- b\n- c\n", "- a\n- b\n- c!\n")).text).toBe("- a!\n- b\n- c!\n");
    expect((await mergeMarkdown(list, "- a\n- b\n- c\n- mine\n", "- a\n- b!\n- c\n")).text).toBe("- a\n- b!\n- c\n- mine\n");
  });

  it("keeps a table whole when each side edits a row next to the other's", async () => {
    const table = "| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n";
    const merged = await mergeMarkdown(table, table.replace("| 1 | 2 |", "| one | 2 |"), table.replace("| 3 | 4 |", "| 3 | four |"));
    expect(merged).toEqual({ text: "| a | b |\n| - | - |\n| one | 2 |\n| 3 | four |\n", overwritten: [] });
    const list = "- a\n- b\n";
    expect((await mergeMarkdown(list, "- a!\n- b\n", "- a\n- b!\n")).text).toBe("- a!\n- b!\n");
  });

  it("never runs a paragraph into the list item before it", async () => {
    const list = "- a\n- b\n";
    const merged = await mergeMarkdown(list, "- a\n- b\n- mine\n", "- a\n- b\n\nTheirs.\n");
    expect(merged.text).toBe("- a\n- b\n\nTheirs.\n\n- mine\n");
    expect(await units(merged.text)).toEqual(["- a", "- b", "Theirs.", "- mine"]);
  });

  it("keeps a file's CRLF line ends", async () => {
    const crlf = "One.\r\n\r\nTwo.\r\n";
    const merged = await mergeMarkdown(crlf, "One.\r\n\r\nTwo.\r\n\r\nMine.\r\n", "Zero.\r\n\r\nOne.\r\n\r\nTwo.\r\n");
    expect(merged.text).toBe("Zero.\r\n\r\nOne.\r\n\r\nTwo.\r\n\r\nMine.\r\n");
  });

  it("takes one side when the same change was made on both, or one side didn't change", async () => {
    const same = base.replace("First", "Same");
    expect(await mergeMarkdown(base, same, same)).toEqual({ text: same, overwritten: [] });
    expect(await mergeMarkdown(base, base, same)).toEqual({ text: same, overwritten: [] });
    expect(await mergeMarkdown(base, same, base)).toEqual({ text: same, overwritten: [] });
  });

  it("merges a file both sides added", async () => {
    expect(await mergeMarkdown("", "# Mine\n", "# Theirs\n")).toEqual({ text: "# Theirs\n\n# Mine\n", overwritten: [] });
  });

  it("is deterministic", async () => {
    const mine = base.replace("First", "Mine").replace("Second", "Also mine");
    const theirs = base.replace("First", "Theirs");
    expect(await mergeMarkdown(base, mine, theirs)).toEqual(await mergeMarkdown(base, mine, theirs));
  });

  it("merges an 8,000-line document quickly", async () => {
    const lines = Array.from({ length: 2_000 }, (_, i) => `Paragraph ${i} with some words in it.\n\n- item ${i}\n`);
    const big = lines.join("\n");
    const mine = big.replace("Paragraph 10 ", "Paragraph ten ");
    const theirs = big.replace("Paragraph 1900 ", "Paragraph nineteen hundred ");
    await mergeMarkdown(big, mine, theirs);
    const start = performance.now();
    const merged = await mergeMarkdown(big, mine, theirs);
    const elapsed = performance.now() - start;
    expect(merged).toEqual({ text: mine.replace("Paragraph 1900 ", "Paragraph nineteen hundred "), overwritten: [] });
    expect(elapsed).toBeLessThan(1_000);
  });
});
