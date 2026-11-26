import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import { Node as PMNode } from "@tiptap/pm/model";
import { createMarkdownCodec } from "@/components/editor/markdown-codec";
import { editorExtensions } from "@/components/editor/tiptap-editor-kit";
import { arrived, peerDecorations, wipDecorations } from "./sync-editor";
import type { SyncPeer } from "./sync-machine";
import { cursorAt, keyedUnits, peerUnitsOf } from "./sync-units";

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
  const units = [{ ...unit!, path: "note.md", holder: { peer: bob, agent: false }, keys: [mine, typed] }];
  const held = new Map([[mine, { peer: bob, agent: false }]]);

  it("names the peer whose typing it draws, so their block isn't named again", () => {
    expect([...wipDecorations(here, units, [bob], held, new Map()).named]).toEqual(["b"]);
  });

  it("names nobody on it once their cursor is in another file, at the same place there", () => {
    const elsewhere = { ...bob, cursor: { path: "other.md", unit: unit!.at } };
    expect(wipDecorations(here, units, [elsewhere], held, new Map()).named.size).toBe(0);
  });

  it("names nobody when it draws nothing: a race this device won keeps its own text, and their block shows them", () => {
    const drawn = wipDecorations(here, units, [bob], new Map(), new Map());
    expect(drawn.decorations.find()).toEqual([]);
    expect(drawn.named.size).toBe(0);
  });
});

describe("peerDecorations", () => {
  // Bob's copy, his caret in "Bob is here."; Ada's, with a paragraph she
  // just added above it that Bob's copy hasn't yet.
  const bobs = doc("First paragraph.\n\nBob is here.\n\nLast paragraph.\n");
  const adas = doc("First paragraph.\n\nAda just added this.\n\nBob is here.\n\nLast paragraph.\n");
  const caret = (text: string) => {
    const unit = keyedUnits(bobs).find(({ from, to }) => bobs.textBetween(from, to) === text)!;
    return { path: "note.md", ...cursorAt(bobs, unit.from + 2) };
  };
  const bob = (cursor: SyncPeer["cursor"]): SyncPeer => ({ deviceId: "b", name: "Bob", colour: "#2f7ed8", cursor, claims: [], wip: null });
  const marked = (shown: PMNode, peer: SyncPeer) =>
    peerDecorations(shown, "note.md", [peer]).find().map(({ from, to }) => shown.textBetween(from, to));

  it("marks the block a peer is in, though this copy has another above it", () => {
    expect(marked(adas, bob(caret("Bob is here.")))).toEqual(["Bob is here."]);
  });

  it("marks nothing for a block this copy doesn't have yet", () => {
    const typed = doc("First paragraph.\n\nBob typed this.\n");
    const cursor = { path: "note.md", ...cursorAt(typed, keyedUnits(typed)[1]!.from + 2) };
    expect(marked(adas, bob(cursor))).toEqual([]);
  });

  it("goes by place for a cursor with no key, as a build before keys sends", () => {
    expect(marked(adas, bob({ path: "note.md", unit: 1 }))).toEqual(["Ada just added this."]);
  });
});
