/**
 * The MET-271 merge case table. Every case checks the shared invariants
 * (no conflict markers, deterministic, stable under the codec) on top of
 * its own expectation.
 */
import { describe, it, expect } from "vitest";
import { createMarkdownCodec } from "@/components/editor/markdown-codec";
import { createMarkdownMerge, mergeText, type MergeInput } from "./merge";
import { alignBlocks, mapBlockIndex, splitBlocks } from "./blocks";

const codec = createMarkdownCodec();
const merge = createMarkdownMerge(codec);
const canon = (md: string) => codec.serialize(codec.parse(md));

function ok(input: MergeInput) {
  const result = merge(input);
  if ("failed" in result) throw new Error(`merge failed: ${result.failed}`);
  expect(merge(input)).toEqual(result);
  expect(result.content).not.toMatch(/^(<{7}|={7}|>{7})/m);
  expect(canon(canon(result.content))).toBe(canon(result.content));
  return result;
}

const doc = (...blocks: string[]) => canon(blocks.join("\n\n"));

describe("character-level diff3 inside a block", () => {
  it("keeps edits to different parts of a block", () => {
    expect(
      mergeText("The quick fox jumps.", "The quick brown fox jumps.", "The quick fox jumps high."),
    ).toEqual({ text: "The quick brown fox jumps high.", overwritten: [] });
  });

  it("keeps both same-spot inserts, holder first", () => {
    expect(mergeText("ab", "aXb", "aYb")).toEqual({ text: "aXYb", overwritten: [] });
  });

  it("keeps typing at neighbouring word boundaries apart", () => {
    expect(mergeText("This is a novel.", "This is a ogamut alpha novel.", "This is tcedar harbor a novel.")).toEqual({
      text: "This is tcedar harbor a ogamut alpha novel.",
      overwritten: [],
    });
  });

  it("applies a change both sides made identically once", () => {
    expect(mergeText("a [b] c", "a \\[b\\] c!", "a \\[b\\] c")).toEqual({ text: "a \\[b\\] c!", overwritten: [] });
    expect(mergeText("one two", "one 2 two", "one 2 two.")).toEqual({ text: "one 2 two.", overwritten: [] });
  });

  it("gives a rewrite that touches the other side's edit to the holder whole", () => {
    const r = mergeText("so word is", "so odelta brisk is", "so tbrisk juniper is");
    expect(r.text).toBe("so odelta brisk is");
    expect(r.overwritten.join("")).toContain("juniper");
  });

  it("gives an overlap to the holder and returns the loser's text", () => {
    expect(mergeText("the cat sat", "the dog sat", "the cow sat")).toEqual({
      text: "the dog sat",
      overwritten: ["cow"],
    });
  });
});

describe("block alignment", () => {
  it("is LCS with ties broken by position", () => {
    expect(alignBlocks(["a", "x", "a"], ["a"])).toEqual([0, -1, -1]);
    expect(alignBlocks(["a", "b", "c"], ["b", "c", "a"])).toEqual([-1, 0, 1]);
  });

  it("maps a block index across versions", () => {
    const from = ["h", "p1", "p2", "p3"];
    expect(mapBlockIndex(from, ["h", "new", "p1", "p2", "p3"], 2)).toBe(3);
    expect(mapBlockIndex(from, ["h", "p1", "p2 edited", "p3"], 2)).toBe(2);
    expect(mapBlockIndex(from, ["h", "p1", "p3"], 2)).toBeNull();
    expect(mapBlockIndex(from, ["p3"], 0)).toBeNull();
  });

  it("splits top-level blocks, a whole list being one", () => {
    expect(splitBlocks(codec, "# T\n\n- a\n- b\n\npara")).toEqual(["# T", "- a\n- b", "para"]);
  });
});

describe("markdown merge case table", () => {
  const base = doc(
    "# Title",
    "First paragraph with some words.",
    "Second paragraph here.",
    "Third paragraph at the end.",
  );

  it("is identity when nothing changed", () => {
    expect(ok({ base, ours: base, theirs: base, holder: "ours" }).content).toBe(base);
  });

  it("keeps edits to different blocks", () => {
    const ours = base.replace("First paragraph", "First edited paragraph");
    const theirs = base.replace("Third paragraph", "Third changed paragraph");
    const r = ok({ base, ours, theirs, holder: "theirs" });
    expect(r.content).toBe(
      base
        .replace("First paragraph", "First edited paragraph")
        .replace("Third paragraph", "Third changed paragraph"),
    );
    expect(r.overwritten).toEqual([]);
  });

  it("keeps edits to different parts of one block", () => {
    const ours = base.replace("First paragraph", "First long paragraph");
    const theirs = base.replace("some words.", "some more words.");
    expect(ok({ base, ours, theirs, holder: "theirs" }).content).toContain(
      "First long paragraph with some more words.",
    );
  });

  it("keeps both same-spot inserts with the holder's first", () => {
    const ours = base.replace("Second paragraph here.", "Second paragraph here. Ours.");
    const theirs = base.replace("Second paragraph here.", "Second paragraph here. Theirs.");
    expect(ok({ base, ours, theirs, holder: "theirs" }).content).toContain(
      "Second paragraph here. Theirs. Ours.",
    );
    expect(ok({ base, ours, theirs, holder: "ours" }).content).toContain(
      "Second paragraph here. Ours. Theirs.",
    );
  });

  it("keeps both same-spot block inserts with the holder's first", () => {
    const ours = doc("# Title", "Ours new block.", "First paragraph with some words.", "Second paragraph here.", "Third paragraph at the end.");
    const theirs = doc("# Title", "Theirs new block.", "First paragraph with some words.", "Second paragraph here.", "Third paragraph at the end.");
    const r = ok({ base, ours, theirs, holder: "theirs" });
    expect(r.content.indexOf("Theirs new block.")).toBeLessThan(r.content.indexOf("Ours new block."));
    expect(r.content).toContain("First paragraph with some words.");
  });

  it("gives overlapping edits to the holder and returns the overwritten text", () => {
    const ours = base.replace("Second paragraph here.", "Second paragraph rewritten by ours.");
    const theirs = base.replace("Second paragraph here.", "Second paragraph rewritten by theirs.");
    const r = ok({ base, ours, theirs, holder: "theirs" });
    expect(r.content).toContain("Second paragraph rewritten by theirs.");
    expect(r.content).not.toContain("ours");
    expect(r.overwritten.join("")).toContain("ours");
  });

  it("keeps the edit when one side deletes the block the other edits", () => {
    const ours = doc("# Title", "First paragraph with some words.", "Third paragraph at the end.");
    const theirs = base.replace("Second paragraph here.", "Second paragraph, edited.");
    for (const holder of ["ours", "theirs"] as const) {
      const r = ok({ base, ours, theirs, holder });
      expect(r.content).toContain("Second paragraph, edited.");
    }
  });

  it("keeps typing at a block's end on that block when the other side inserts after it", () => {
    const ours = base.replace("Second paragraph here.", "Second paragraph here. More.");
    const theirs = doc("# Title", "First paragraph with some words.", "Second paragraph here.", "Inserted.", "Third paragraph at the end.");
    for (const holder of ["ours", "theirs"] as const) {
      expect(ok({ base, ours, theirs, holder }).content).toBe(
        doc("# Title", "First paragraph with some words.", "Second paragraph here. More.", "Inserted.", "Third paragraph at the end."),
      );
    }
  });

  it("applies a delete and an insert elsewhere", () => {
    const ours = doc("# Title", "Second paragraph here.", "Third paragraph at the end.");
    const theirs = doc(base, "A new closing paragraph.");
    expect(ok({ base, ours, theirs, holder: "theirs" }).content).toBe(
      doc("# Title", "Second paragraph here.", "Third paragraph at the end.", "A new closing paragraph."),
    );
  });

  it("merges headings edited on both sides", () => {
    const ours = base.replace("# Title", "# Better Title");
    const theirs = base.replace("# Title", "## Title");
    const r = ok({ base, ours, theirs, holder: "theirs" });
    expect(r.content).toMatch(/^## Better Title$/m);
  });

  it("merges a list where both sides edit different items", () => {
    const listBase = doc("Intro.", "- apples\n- pears\n- plums", "Outro.");
    const ours = listBase.replace("apples", "green apples");
    const theirs = listBase.replace("plums", "plums\n- figs");
    const r = ok({ base: listBase, ours, theirs, holder: "theirs" });
    expect(r.content).toBe(doc("Intro.", "- green apples\n- pears\n- plums\n- figs", "Outro."));
  });

  it("merges a task list where both sides tick different items", () => {
    const listBase = doc("- [ ] one\n- [ ] two\n- [ ] three");
    const ours = listBase.replace("[ ] one", "[x] one");
    const theirs = listBase.replace("[ ] three", "[x] three");
    expect(ok({ base: listBase, ours, theirs, holder: "ours" }).content).toBe(
      doc("- [x] one\n- [ ] two\n- [x] three"),
    );
  });

  it("merges a table where both sides edit different cells", () => {
    const tableBase = doc("| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |");
    const ours = tableBase.replace("| 1 |", "| one |");
    const theirs = tableBase.replace("| 4 |", "| four |");
    const r = ok({ base: tableBase, ours, theirs, holder: "theirs" });
    expect(r.content).toContain("one");
    expect(r.content).toContain("four");
    expect(r.content).toContain("| 3 ");
  });

  it("merges a table where one side adds a row and the other edits a cell", () => {
    const tableBase = doc("| a | b |\n| --- | --- |\n| 1 | 2 |");
    const ours = canon(tableBase + "\n| 5 | 6 |");
    const theirs = tableBase.replace("| 2 |", "| two |");
    const r = ok({ base: tableBase, ours, theirs, holder: "theirs" });
    expect(r.content).toContain("two");
    expect(r.content).toContain("| 5 ");
  });

  it("merges a code block where both sides edit different lines", () => {
    const codeBase = doc("```ts\nconst a = 1;\nconst b = 2;\nconst c = 3;\n```");
    const ours = codeBase.replace("a = 1", "a = 10");
    const theirs = codeBase.replace("c = 3", "c = 30");
    expect(ok({ base: codeBase, ours, theirs, holder: "ours" }).content).toBe(
      doc("```ts\nconst a = 10;\nconst b = 2;\nconst c = 30;\n```"),
    );
  });

  it("merges frontmatter edited on one side with body edits on the other", () => {
    const fmBase = canon("---\ntitle: x\n---\n\nBody text.");
    const ours = fmBase.replace("title: x", "title: y");
    const theirs = fmBase.replace("Body text.", "Body text, edited.");
    expect(ok({ base: fmBase, ours, theirs, holder: "theirs" }).content).toBe(
      canon("---\ntitle: y\n---\n\nBody text, edited."),
    );
  });

  it("never emits conflict markers when both sides rewrite everything", () => {
    const ours = doc("Totally different ours.");
    const theirs = doc("Completely other theirs.", "- and a list");
    const r = ok({ base, ours, theirs, holder: "theirs" });
    expect(r.content).not.toMatch(/<<<<<<<|>>>>>>>/);
  });
});

describe("source bytes of blocks neither side changed", () => {
  // Lossy constructs: the codec drops the comment, joins the wrapped
  // lines, rewrites `_x_` and adds nothing at the end.
  const base = [
    "# Title",
    "",
    "<!-- keep this comment -->",
    "",
    "A hard-wrapped paragraph that",
    "spans three lines with _emphasis_",
    "and no reflow.",
    "",
    "Second paragraph here.",
    "",
    "Third paragraph at the end.",
    "",
  ].join("\n");

  it("copies untouched blocks byte for byte when the sides edit other blocks", () => {
    const ours = base.replace("Second paragraph here.", "Second paragraph, ours.");
    const theirs = base.replace("Third paragraph at the end.", "Third paragraph, theirs.");
    const r = ok({ base, ours, theirs, holder: "theirs" });
    expect(r.content).toBe(
      base
        .replace("Second paragraph here.", "Second paragraph, ours.")
        .replace("Third paragraph at the end.", "Third paragraph, theirs."),
    );
    expect(r.stats).toEqual({ theirsChanged: 1, collided: 0 });
  });

  it("keeps the comment and the wrapped lines next to a block merged character by character", () => {
    const ours = base.replace("Second paragraph here.", "Second long paragraph here.");
    const theirs = base.replace("Second paragraph here.", "Second paragraph here, too.");
    const r = ok({ base, ours, theirs, holder: "theirs" });
    expect(r.content).toContain("<!-- keep this comment -->");
    expect(r.content).toContain("A hard-wrapped paragraph that\nspans three lines with _emphasis_\nand no reflow.");
    expect(r.content).toContain("Second long paragraph here, too.");
    expect(r.content.endsWith("Third paragraph at the end.\n")).toBe(true);
  });

  it("keeps base bytes where an editor save re-wrote the whole file in the codec's form", () => {
    // What the editor writes after one edit: the whole file canonical.
    const ours = canon(base).replace("Second paragraph here.", "Second paragraph, typed in Notefig.");
    const theirs = base.replace("Third paragraph at the end.", "Third paragraph, from plain git.");
    const r = ok({ base, ours, theirs, holder: "theirs" });
    expect(r.content).toBe(
      base
        .replace("Second paragraph here.", "Second paragraph, typed in Notefig.")
        .replace("Third paragraph at the end.", "Third paragraph, from plain git."),
    );
  });

  it("is the base itself, byte for byte, when nothing changed", () => {
    expect(ok({ base, ours: base, theirs: base, holder: "ours" }).content).toBe(base);
  });

  it("takes a side's own bytes for a block only that side changed", () => {
    const ours = base.replace("Third paragraph at the end.", "Third\nparagraph, wrapped by ours.");
    const r = ok({ base, ours, theirs: base, holder: "theirs" });
    expect(r.content).toBe(ours);
  });

  it("keeps a blank line between blocks that came from different places", () => {
    const tight = "# Title\nFirst line.\n";
    const ours = "# Title\nFirst line.\n\nAppended by ours.\n";
    const theirs = "# Title changed\nFirst line.\n";
    const r = ok({ base: tight, ours, theirs, holder: "theirs" });
    expect(r.content).toBe("# Title changed\n\nFirst line.\n\nAppended by ours.\n");
  });
});

describe("holder", () => {
  const base = doc("# Title", "Alpha paragraph.", "Beta paragraph.");
  const ours = base.replace("Alpha paragraph.", "Alpha by ours.").replace("Beta paragraph.", "Beta by ours.");
  const theirs = base.replace("Alpha paragraph.", "Alpha by theirs.").replace("Beta paragraph.", "Beta by theirs.");

  it("can be decided per overlapping run of base blocks", () => {
    const asked: number[] = [];
    const r = ok({
      base,
      ours,
      theirs,
      holder: ({ start, base: blocks }) => {
        asked.push(start);
        expect(blocks).toEqual(["# Title", "Alpha paragraph.", "Beta paragraph."]);
        return start === 1 ? "ours" : "theirs";
      },
    });
    // Asked once per merge (`ok` merges twice, for determinism).
    expect(asked).toEqual([1, 1]);
    // One run covers both blocks (adjacent hunks), so ours holds it all.
    expect(r.content).toContain("Alpha by ours.");
  });

  it("asks separately for runs that don't touch", () => {
    const spread = doc("Alpha paragraph.", "Middle.", "Beta paragraph.");
    const o = spread.replace("Alpha paragraph.", "Alpha by ours.").replace("Beta paragraph.", "Beta by ours.");
    const t = spread.replace("Alpha paragraph.", "Alpha by theirs.").replace("Beta paragraph.", "Beta by theirs.");
    const r = ok({ base: spread, ours: o, theirs: t, holder: ({ start }) => (start === 0 ? "ours" : "theirs") });
    expect(r.content).toBe(doc("Alpha by ours.", "Middle.", "Beta by theirs."));
    expect(r.overwritten.join(" ")).toContain("theirs");
    expect(r.overwritten.join(" ")).toContain("ours");
    expect(r.stats).toEqual({ theirsChanged: 2, collided: 2 });
  });
});
