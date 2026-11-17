import { describe, expect, it } from "vitest";
import { createMarkdownCodec } from "@/components/editor/markdown-codec";
import { serializeKeeping, splitUnits } from "./markdown-units";

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

/** Save `edited` (as the editor would hold it) over `source` on disk. */
async function save(source: string, edited: string, canonical: string | null = null) {
  const result = await serializeKeeping(codec, codec.parse(edited), { source, canonical });
  // Whatever is written reads back as the document that was saved.
  expect(codec.parse(result.markdown)).toEqual(codec.parse(result.canonical));
  return result;
}

describe("serializeKeeping", () => {
  it("writes the source back byte for byte when nothing changed", async () => {
    const { markdown, canonical } = await save(SOURCE, SOURCE);
    expect(canonical).not.toBe(SOURCE);
    expect(markdown).toBe(SOURCE);
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

  it("gives the same result with the previous serialization handed in", async () => {
    const edited = SOURCE.replace("Plain paragraph two.", "Plain paragraph deux.");
    const previous = codec.serialize(codec.parse(SOURCE));
    expect((await save(SOURCE, edited, previous)).markdown).toBe((await save(SOURCE, edited)).markdown);
  });

  it("writes the plain serialization when there's no previous source", async () => {
    const result = await serializeKeeping(codec, codec.parse(SOURCE), null);
    expect(result.markdown).toBe(result.canonical);
    expect(result.hash).toBe(codec.hash(result.canonical));
  });

  it("writes the plain serialization when keeping bytes would change the document", async () => {
    // A link reference definition makes no unit of its own: it rides with
    // the paragraph above, which the serializer rewrites with the link
    // inlined, so the kept paragraph below would lose its target.
    const source = "See [x].\n\n[x]: https://example.com\n\nKept [x] too.\n";
    const edited = source.replace("See", "Look at");
    const { markdown, canonical } = await save(source, edited);
    expect(markdown).toBe(canonical);
  });

  it("keeps only the ending of a file already in the serializer's style", async () => {
    const plain = "# Title\n\n- one\n- two\n\nText.\n";
    const edited = plain.replace("Text.", "Text, more.");
    expect((await save(plain, edited)).markdown).toBe(edited);
    expect((await save(plain.trimEnd(), edited)).markdown).toBe(edited.trimEnd());
  });

  it("hashes what it writes", async () => {
    const edited = SOURCE.replace("Plain paragraph one.", "Plain paragraph uno.");
    const result = await save(SOURCE, edited);
    expect(result.hash).toBe(codec.hash(result.markdown));
  });
});
