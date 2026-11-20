import { describe, expect, it } from "vitest";
import { createMarkdownCodec } from "@/components/editor/markdown-codec";
import { getSchema } from "@tiptap/core";
import { Node as PMNode } from "@tiptap/pm/model";
import { editorExtensions } from "@/components/editor/tiptap-editor-kit";
import { cursorAt, docUnits, keyedUnits, unitKeysOf, unitsIn } from "./sync-units";
import { editBetween, refusalMessage } from "./sync-claims";

const codec = createMarkdownCodec();
const doc = (markdown: string) => PMNode.fromJSON(getSchema(editorExtensions), codec.parse(markdown));

describe("sync carets' units", () => {
  it("counts a bound prompt widget as one unit, whatever its draft holds, and an unbound one as none", () => {
    const markdown = '<!-- notefig:prompt id="blob_a" task="task_a" -->\n\nAfter the widget.\n';
    const plain = doc(markdown);
    const json = plain.toJSON();
    json.content[0].content = [{ type: "promptDraft", content: [{ type: "text", text: "an unsent draft" }] }];
    const drafted = PMNode.fromJSON(plain.type.schema, json);
    const unbound = plain.toJSON();
    unbound.content[0].attrs = { ...unbound.content[0].attrs, taskId: null };
    const [first] = docUnits(PMNode.fromJSON(plain.type.schema, unbound));
    expect(PMNode.fromJSON(plain.type.schema, unbound).textBetween(first.from, first.to)).toBe("After the widget.");
    for (const shown of [plain, drafted]) {
      const [, after] = docUnits(shown);
      expect(shown.textBetween(after.from, after.to)).toBe("After the widget.");
      expect(cursorAt(shown, after.from + 3)).toEqual({ unit: 1, offset: 2 });
    }
  });
});

describe("sync claims' units", () => {
  it("names a unit by its kind and text, the same whatever its marks or the text above", () => {
    const plain = doc("# Title\n\nA paragraph.\n");
    const bold = doc("# Title\n\nA **paragraph**.\n");
    const moved = doc("# Title\n\nSomething new above.\n\nA paragraph.\n");
    expect(unitKeysOf(bold)).toEqual(unitKeysOf(plain));
    expect(unitKeysOf(moved)[2]).toBe(unitKeysOf(plain)[1]);
    // A heading and a paragraph that say the same are two units.
    expect(unitKeysOf(doc("# Same\n\nSame\n"))[0]).not.toBe(unitKeysOf(doc("# Same\n\nSame\n"))[1]);
  });

  it("finds the units an edit touches: the one around a caret, an empty one, a list item's", () => {
    const shown = doc("First.\n\n- one\n- two\n");
    const [first, one] = keyedUnits(shown);
    expect(unitsIn(shown, first.from + 2, first.from + 2).map((u) => u.key)).toEqual([first.key]);
    expect(unitsIn(shown, first.from + 1, one.from + 2).map((u) => u.key)).toEqual([first.key, one.key]);
    const empty = PMNode.fromJSON(shown.type.schema, { type: "doc", content: [{ type: "paragraph" }] });
    expect(unitsIn(empty, 1, 1)).toEqual([{ from: 0, to: 2, key: null }]);
    // Between blocks: nothing existing.
    expect(unitsIn(shown, first.to, first.to)).toEqual([]);
  });
});

describe("sync claims of a write", () => {
  it("pairs what a write changed with what replaced it, and lists what it created last", () => {
    expect(editBetween(["a", "b", "c"], ["a", "B", "new", "c", "end"])).toEqual({ before: ["b"], after: ["B", "new", "end"] });
    expect(editBetween(["a", "b"], ["a"])).toEqual({ before: ["b"], after: [] });
    expect(editBetween(["a"], ["a"])).toEqual({ before: [], after: [] });
  });

  it("tells an agent who to wait for, or to make smaller edits, and that nothing was written", () => {
    const holder = (name: string, agent: boolean) => ({
      peer: { deviceId: name, name, colour: null, cursor: null, claims: [] },
      agent,
    });
    expect(refusalMessage("docs/ideas.md", { kind: "held", holders: [holder("Ada", false), holder("Bob", true)] })).toBe(
      "Refused: Ada and Bob's agent are editing paragraphs of ideas.md this edit touches. Nothing was written. Edit other paragraphs, or try again in a few seconds.",
    );
    expect(refusalMessage("ideas.md", { kind: "cap", needed: 7 })).toMatch(/at most 4 paragraphs at a time, and this edit would make 7\. Nothing was written/);
  });
});
