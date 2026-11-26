import { describe, expect, it } from "vitest";
import { Editor, getSchema } from "@tiptap/core";
import { ADOPTION_TRANSACTION_META } from "@/components/editor/adopt-external-content";
import { Node as PMNode } from "@tiptap/pm/model";
import { createMarkdownCodec } from "@/components/editor/markdown-codec";
import { editorExtensions } from "@/components/editor/tiptap-editor-kit";
import { arrived, createSyncEditors, peerDecorations, wipDecorations } from "./sync-editor";
import { createClaims } from "./sync-claims";
import { INITIAL_SYNC_STATE, type SyncPeer } from "./sync-machine";
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

describe("sync editors", () => {
  it("marks a peer's block once a write that isn't typing brings it", () => {
    const editor = new Editor({ extensions: editorExtensions, content: codec.parse("First paragraph.\n\nLast paragraph.\n") });
    // Bob is in a paragraph this copy doesn't have yet.
    const theirs = doc("First paragraph.\n\nBob is here.\n\nLast paragraph.\n");
    const bob: SyncPeer = {
      deviceId: "b",
      name: "Bob",
      colour: "#2f7ed8",
      cursor: { path: "note.md", ...cursorAt(theirs, keyedUnits(theirs)[1]!.from + 2) },
      claims: [],
      wip: null,
    };
    const editors = createSyncEditors({
      editors: { markdownEditor: () => editor, paths: () => ["/ws/note.md"] },
      tree: () => "note.md",
      onCursor: () => {},
      claims: createClaims({ deviceId: "m", now: () => 0, peers: () => [bob] }),
      wip: { in: () => [] },
      setTimer: () => () => {},
    });
    editors.reconcile({ ...INITIAL_SYNC_STATE, setup: "on", peers: [bob] });
    const marked = () => [...editor.view.dom.querySelectorAll(".sync-here")].map((el) => el.textContent);
    expect(marked()).toEqual([]);

    // Sync brings it in: Bob shows there, with no new presence.
    const paragraph = editor.schema.nodes.paragraph!.create(null, editor.schema.text("Bob is here."));
    editor.view.dispatch(editor.state.tr.insert(editor.state.doc.child(0).nodeSize, paragraph).setMeta(ADOPTION_TRANSACTION_META, true));
    expect(marked()).toEqual(["Bob is here."]);
    editors.stop();
    editor.destroy();
  });
});
