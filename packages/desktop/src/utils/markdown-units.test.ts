import { describe, expect, it, vi } from "vitest";
import { createMarkdownCodec } from "@/components/editor/markdown-codec";
import type { JSONContent } from "@tiptap/core";
import { serializeKeeping, splitUnits, type KeptSave } from "./markdown-units";

const codec = createMarkdownCodec();
const units = async (source: string) => (await splitUnits(source)).map((unit) => unit.text);

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

/** Everything the serializer would write differently: setext heading,
 *  `*` bullets, 4-space sub-items, `__bold__`, extra blank lines, an
 *  unpadded table rule, `1)` markers, a `~~~` fence, a final newline. */
const SOURCE = [
  "---\ntitle: x\n---\n",
  "Setext\n======\n",
  "* star one\n* star two\n    * deep\n",
  "__bold__ and *em* here.\n\n\n",
  "Plain paragraph one.\n",
  "Plain paragraph two.\n",
  "| a | b |\n|---|---|\n| 1 | 2 |\n",
  "1) first\n2) second\n",
  "~~~\ncode\n~~~\n",
  "End line.\n",
].join("\n");

/** Save `edited` (as the editor would hold it) over `source` on disk: the
 *  first save after a load, or the next one after `last`. */
async function save(source: string, edited: string, last?: KeptSave, doc: JSONContent | null = null) {
  const saved = codec.parse(edited);
  const result = await serializeKeeping(codec, saved, last?.saved ?? { source, doc });
  // Whatever is written reads back as the document that was saved, or at
  // worst as the plain serialization does (which loses table alignment,
  // and runs two lists of one kind into one).
  const read = codec.parse(result.markdown);
  if (JSON.stringify(read) !== JSON.stringify(saved)) expect(read).toEqual(codec.parse(codec.serialize(saved)));
  return result;
}

/** Saves of each edit in turn, as typing makes them: each carries the
 *  last one's segments. */
async function saves(source: string, ...edits: ((text: string) => string)[]) {
  let text = source;
  let last: KeptSave | undefined;
  for (const edit of edits) {
    text = edit(text);
    last = await save(source, text, last);
  }
  return last!;
}

describe("serializeKeeping", () => {
  it("writes the source back byte for byte when nothing changed", async () => {
    expect(codec.serialize(codec.parse(SOURCE))).not.toBe(SOURCE);
    expect((await save(SOURCE, SOURCE)).markdown).toBe(SOURCE);
  });

  it("rewrites only the paragraph that changed", async () => {
    const edited = SOURCE.replace("Plain paragraph one.", "Plain paragraph uno.");
    expect((await save(SOURCE, edited)).markdown).toBe(edited);
  });

  it("rewrites only the heading that changed, in the serializer's style", async () => {
    const edited = SOURCE.replace("Setext\n======", "Renamed\n======");
    expect((await save(SOURCE, edited)).markdown).toBe(SOURCE.replace("Setext\n======", "# Renamed"));
  });

  it("rewrites only the table row that changed", async () => {
    const edited = SOURCE.replace("| 1 | 2 |", "| 1 | 3 |");
    expect((await save(SOURCE, edited)).markdown).toBe(edited);
  });

  it("rewrites a list whose item changed, and nothing around it", async () => {
    const edited = SOURCE.replace("* star two", "* star 2");
    const { markdown } = await save(SOURCE, edited);
    // A `-` item among `*` ones would start a list of its own: the list is
    // the serializer's, everything else the source's.
    expect(markdown).toBe(SOURCE.replace("* star one\n* star two\n    * deep", "- star one\n- star 2\n  - deep"));
  });

  it("rewrites a loose list whose item changed, and nothing around it", async () => {
    const source = "__bold__ before.\n\n* one\n\n* two\n\n* three\n\n__bold__ outside.\n";
    const edited = source.replace("* two", "* 2");
    const list = codec.serialize(codec.parse("* one\n\n* 2\n\n* three\n"));
    expect((await save(source, edited)).markdown).toBe(`__bold__ before.\n\n${list}\n\n__bold__ outside.\n`);
  });

  it("keeps an untouched table's column alignment, which the serializer drops", async () => {
    const source = "| x | y |\n|:--|--:|\n| 3 | 4 |\n\nText.\n";
    const edited = source.replace("Text.", "Text, more.");
    expect((await save(source, edited)).markdown).toBe(edited);
  });

  it("keeps the units around an added paragraph", async () => {
    const edited = SOURCE.replace("Plain paragraph two.\n", "Plain paragraph two.\n\nA new one.\n");
    expect((await save(SOURCE, edited)).markdown).toBe(edited);
  });

  it("keeps the units around a deleted paragraph", async () => {
    const edited = SOURCE.replace("Plain paragraph one.\n\n", "");
    expect((await save(SOURCE, edited)).markdown).toBe(edited);
  });

  it("keeps the file's final newline, and its absence", async () => {
    const bare = SOURCE.trimEnd();
    const edited = bare.replace("Plain paragraph one.", "Plain paragraph uno.");
    expect((await save(bare, edited)).markdown).toBe(edited);
    const changedLast = SOURCE.replace("End line.", "Last line.");
    expect((await save(SOURCE, changedLast)).markdown).toBe(changedLast);
  });

  it("keeps CRLF line ends, also in the units it rewrites", async () => {
    const crlf = SOURCE.replace(/\n/g, "\r\n");
    const edited = crlf.replace("Plain paragraph one.", "Plain paragraph uno.");
    expect((await save(crlf, edited)).markdown).toBe(edited);
  });

  it("gives the same result with the loaded doc handed in", async () => {
    const edited = SOURCE.replace("Plain paragraph two.", "Plain paragraph deux.");
    const withDoc = await save(SOURCE, edited, undefined, codec.parse(SOURCE));
    expect(withDoc.markdown).toBe((await save(SOURCE, edited)).markdown);
  });

  it("writes the plain serialization when there's no previous file", async () => {
    const result = await serializeKeeping(codec, codec.parse(SOURCE), null);
    expect(result.markdown).toBe(codec.serialize(codec.parse(SOURCE)));
    expect(result.hash).toBe(codec.hash(result.markdown));
  });

  it("writes the plain serialization when keeping bytes would change the document", async () => {
    // A link reference definition makes no unit of its own: it rides with
    // the paragraph above, which the serializer rewrites with the link
    // inlined, so the kept paragraph below would lose its target.
    const source = "See [x].\n\n[x]: https://example.com\n\nKept [x] too.\n";
    const edited = source.replace("See", "Look at");
    expect((await save(source, edited)).markdown).toBe(`${codec.serialize(codec.parse(edited))}\n`);
  });

  it("keeps only the ending of a file already in the serializer's style", async () => {
    const plain = "# Title\n\n- one\n- two\n\nText.\n";
    const edited = plain.replace("Text.", "Text, more.");
    expect((await save(plain, edited)).markdown).toBe(edited);
    expect((await save(plain.trimEnd(), edited)).markdown).toBe(edited.trimEnd());
  });

  describe("from save to save", () => {
    it("keeps the untouched units across several saves in different places", async () => {
      const last = await saves(
        SOURCE,
        (text) => text.replace("Plain paragraph one.", "Plain paragraph uno."),
        (text) => text.replace("Plain paragraph uno.", "Plain paragraph uno, dos."),
        (text) => text.replace("| 1 | 2 |", "| 1 | 3 |"),
        (text) => text.replace("Plain paragraph two.\n", "Plain paragraph two.\n\nAdded.\n"),
      );
      const expected = SOURCE.replace("Plain paragraph one.", "Plain paragraph uno, dos.")
        .replace("| 1 | 2 |", "| 1 | 3 |")
        .replace("Plain paragraph two.\n", "Plain paragraph two.\n\nAdded.\n");
      expect(last.markdown).toBe(expected);
    });

    it("rewrites the list around an item edited on a later save", async () => {
      const last = await saves(
        SOURCE,
        (text) => text.replace("Plain paragraph one.", "Plain paragraph uno."),
        (text) => text.replace("* star two", "* star 2"),
      );
      expect(last.markdown).toBe(
        SOURCE.replace("Plain paragraph one.", "Plain paragraph uno.").replace(
          "* star one\n* star two\n    * deep",
          "- star one\n- star 2\n  - deep",
        ),
      );
    });

    it("keeps the final newline when typing at the end of the file", async () => {
      const last = await saves(
        SOURCE,
        (text) => text.replace("End line.", "End line, more."),
        (text) => text.replace("End line, more.", "End line, more.\n\nAfter it."),
      );
      expect(last.markdown).toBe(SOURCE.replace("End line.", "End line, more.\n\nAfter it."));
    });

    it("saves new text typed into a note that was emptied", async () => {
      const last = await saves(SOURCE, () => "", () => "Fresh start.\n");
      expect(last.markdown).toBe("Fresh start.");
    });

    it("checks the whole file when the change removed a definition others use", async () => {
      const source = "Intro.\n\n[x]: https://example.com\n\nMiddle.\n\nKept [x].\n\nTail.\n";
      const last = await saves(source, (text) => text.replace("Intro.", "Intro, edited."));
      expect(codec.render(last.markdown)).toContain('href="https://example.com"');
    });

    it("writes the same bytes again when nothing changed", async () => {
      const once = await save(SOURCE, SOURCE.replace("Plain paragraph one.", "Plain paragraph uno."));
      const again = await save(SOURCE, SOURCE.replace("Plain paragraph one.", "Plain paragraph uno."), once);
      expect(again.markdown).toBe(once.markdown);
    });

    it("renders only the blocks around the change", async () => {
      const big = Array.from({ length: 50 }, (_, i) => `__Para ${i}__ text.\n`).join("\n");
      const first = await save(big, big.replace("Para 10__ text", "Para 10__ text!"));
      const render = vi.spyOn(codec, "render");
      const second = await save(big, big.replace("Para 10__ text", "Para 10__ text!").replace("Para 40__", "Para 40__ x"), first);
      expect(second.markdown).toBe(big.replace("__Para 10__ text.", "**Para 10** text!.").replace("__Para 40__ text.", "**Para 40** x text."));
      for (const [rendered] of render.mock.calls) expect(rendered.length).toBeLessThan(100);
      render.mockRestore();
    });

    it("renders nothing in a file already in the serializer's style", async () => {
      const plain = "# Title\n\n- one\n- two\n\nText.\n";
      const render = vi.spyOn(codec, "render");
      const split = await saves(plain, (text) => text.replace("Text.", "Text, more."), (text) => text.replace("- two", "- two!"));
      expect(split.markdown).toBe(plain.replace("Text.", "Text, more.").replace("- two", "- two!"));
      expect(render).not.toHaveBeenCalled();
      render.mockRestore();
    });
  });

  it("always writes what parses to the saved document, over many random edits", async () => {
    // Deterministic: the same edits every run.
    let seed = 7;
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    const source = [
      SOURCE,
      "+ plus a\n+ plus b\n\n  indented continuation\n\n+ plus c\n",
      "> quoted __strong__\n> more\n\nAfter the quote.\n",
      "Lazy paragraph\ncontinued here\n",
      "| x | y |\n|-|-|\n| 3 | 4 |\n| 5 | 6 |\n",
    ].join("\n");
    const words = ["alpha", "*beta*", "- gamma", "1. delta", "> eps", "\n\n", "\n", "__z__", "| q |", "    code"];
    let text = source;
    let last: KeptSave | undefined;
    for (let step = 0; step < 60; step++) {
      const lines = text.split("\n");
      const line = random(lines.length);
      const kind = random(3);
      if (kind === 0) lines[line] = `${lines[line]} ${words[random(words.length)]}`;
      else if (kind === 1) lines.splice(line, 0, words[random(words.length)]!);
      else if (lines.length > 3) lines.splice(line, 1);
      // What the editor would hold: the edited text as parsed.
      text = lines.join("\n");
      last = await save(source, text, last);
      text = last.markdown;
    }
  }, 30_000);

  it("hashes what it writes", async () => {
    const edited = SOURCE.replace("Plain paragraph one.", "Plain paragraph uno.");
    const result = await save(SOURCE, edited);
    expect(result.hash).toBe(codec.hash(result.markdown));
  });
});
