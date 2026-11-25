import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import { Node as PMNode } from "@tiptap/pm/model";
import { createMarkdownCodec } from "@/components/editor/markdown-codec";
import { editorExtensions } from "@/components/editor/tiptap-editor-kit";
import { arrived, wipDecorations } from "./sync-editor";
import type { SyncPeer } from "./sync-machine";
import { keyedUnits, peerUnitsOf } from "./sync-units";

const codec = createMarkdownCodec();
const doc = (markdown: string) => PMNode.fromJSON(getSchema(editorExtensions), codec.parse(markdown));

describe("arrived", () => {
  it("is the stretch the new text added, wherever it went", () => {
    expect(arrived("Second paragraph.", "Typed Second paragraph.")).toEqual([0, 6]);
    expect(arrived("We start at nine.", "We start at nine. Lunch is at the venue.")).toEqual([17, 40]);
    expect(arrived("a rough review", "a short review")).toEqual([2, 7]);
    expect(arrived("", "A new one.")).toEqual([0, 10]);
  });

  it("is nothing when text was only taken away, or nothing changed", () => {
    expect(arrived("We start at nine sharp.", "We start at nine.")).toBeNull();
    expect(arrived("Same.", "Same.")).toBeNull();
  });
});

describe("wipDecorations", () => {
  // Bob types in the second paragraph, his cursor in it.
  const here = doc("First paragraph.\n\nSecond paragraph.\n");
  const theirs = doc("First paragraph.\n\nTyped Second paragraph.\n");
  const [mine, typed] = [keyedUnits(here)[1]!.key, keyedUnits(theirs)[1]!.key];
  const [unit] = peerUnitsOf(theirs, [typed]);
  const bob: SyncPeer = { deviceId: "b", name: "Bob", colour: "#2f7ed8", cursor: { path: "note.md", unit: unit!.at }, claims: [], wip: "c" };
  const units = [{ ...unit!, holder: { peer: bob, agent: false }, keys: [mine, typed] }];

  it("names the peer whose typing it draws, so their block isn't named again", () => {
    const held = new Map([[mine, { peer: bob, agent: false }]]);
    expect([...wipDecorations(here, units, [bob], held, new Map()).named]).toEqual(["b"]);
  });

  it("names nobody when it draws nothing: a race this device won keeps its own text, and their block shows them", () => {
    const drawn = wipDecorations(here, units, [bob], new Map(), new Map());
    expect(drawn.decorations.find()).toEqual([]);
    expect(drawn.named.size).toBe(0);
  });
});
