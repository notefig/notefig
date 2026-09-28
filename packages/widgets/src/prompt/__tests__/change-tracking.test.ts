/**
 * Prompt change tracking over a bare ProseMirror state: what a tagged
 * transaction records, how later edits move or drop it, and the store
 * round trip a recreated editor relies on.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Schema } from "@tiptap/pm/model";
import { EditorState, type Transaction } from "@tiptap/pm/state";
import { EditorView } from "@tiptap/pm/view";
import { PROMPT_NODE_NAME } from "../node";
import {
  PROMPT_CHANGE_META,
  discardPromptChanges,
  getDocumentPromptChanges,
  setDocumentPromptChanges,
} from "../change-store";
import {
  promptChangeTrackingPlugin,
  promptChangesOf,
} from "../change-tracking";
import { getPromptBlob, updatePromptBlob } from "../store";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "text*", toDOM: () => ["p", 0] },
    [PROMPT_NODE_NAME]: { group: "block", atom: true, toDOM: () => ["div"] },
    text: {},
  },
});

const DOC_PATH = "/ws/notes.md";
const ROUND = { blobId: "blob_a", turnId: "trn_1" };

function stateOf(...blocks: Array<string | "widget">) {
  const doc = schema.node(
    "doc",
    null,
    blocks.map((block) =>
      block === "widget"
        ? schema.node(PROMPT_NODE_NAME)
        : schema.node("paragraph", null, block ? schema.text(block) : []),
    ),
  );
  return EditorState.create({
    doc,
    plugins: [promptChangeTrackingPlugin(DOC_PATH)],
  });
}

function asRound(tr: Transaction): Transaction {
  return tr.setMeta(PROMPT_CHANGE_META, ROUND);
}

const spans = (state: EditorState) =>
  promptChangesOf(state).map(({ from, to }) => [from, to]);

afterEach(() => {
  discardPromptChanges(ROUND.blobId);
  discardPromptChanges("blob_b");
});

describe("prompt change tracking", () => {
  it("records what a round's transaction touched, and nothing else", () => {
    let state = stateOf("hello world");
    // A user edit is not a round's change.
    state = state.apply(state.tr.insertText("!", 12));
    expect(promptChangesOf(state)).toEqual([]);

    state = state.apply(asRound(state.tr.insertText("big ", 7)));
    expect(promptChangesOf(state)).toEqual([
      { ...ROUND, from: 7, to: 11 },
    ]);
  });

  it("keeps a change on its text as the document moves, and drops it once overwritten", () => {
    let state = stateOf("hello world");
    state = state.apply(asRound(state.tr.insertText("big ", 7)));
    state = state.apply(state.tr.insertText(">> ", 1));
    expect(spans(state)).toEqual([[10, 14]]);
    // Typing at its edge is not part of it.
    state = state.apply(state.tr.insertText("x", 14));
    expect(spans(state)).toEqual([[10, 14]]);
    state = state.apply(state.tr.delete(9, 16));
    expect(promptChangesOf(state)).toEqual([]);
  });

  it("tracks an inserted paragraph by its text, so rewriting the text clears it", () => {
    let state = stateOf("intro");
    const added = schema.node("paragraph", null, schema.text("added"));
    state = state.apply(asRound(state.tr.insert(7, added)));
    expect(spans(state)).toEqual([[8, 13]]);
    state = state.apply(state.tr.insertText("mine", 8, 13));
    expect(promptChangesOf(state)).toEqual([]);
  });

  it("marks a pure deletion as a point", () => {
    let state = stateOf("hello world");
    state = state.apply(asRound(state.tr.delete(6, 12)));
    expect(spans(state)).toEqual([[6, 6]]);
  });

  it("keeps a deletion right beside a widget", () => {
    let state = stateOf("intro", "widget", "outro");
    state = state.apply(asRound(state.tr.delete(0, 7)));
    expect(spans(state)).toEqual([[0, 0]]);
  });

  it("never counts a prompt widget the round re-inserted", () => {
    let state = stateOf("intro", "widget", "outro");
    const widgetPos = 7;
    const widget = state.doc.nodeAt(widgetPos)!;
    // The adoption shape: the rewrite drops the widget, the re-assertion
    // puts it back, both in the one transaction.
    const tr = state.tr.delete(widgetPos, widgetPos + widget.nodeSize);
    tr.insert(widgetPos, widget);
    state = state.apply(asRound(tr));
    expect(promptChangesOf(state)).toEqual([]);
  });

  it("restores into a recreated editor only onto the document it was mapped on", () => {
    const view = new EditorView(document.createElement("div"), {
      state: stateOf("hello world"),
    });
    view.dispatch(asRound(view.state.tr.insertText("big ", 7)));
    expect(getDocumentPromptChanges(DOC_PATH)).toHaveLength(1);
    const doc = view.state.doc;
    view.destroy();

    const recreate = (content: typeof doc) =>
      EditorState.create({
        doc: content,
        plugins: [promptChangeTrackingPlugin(DOC_PATH)],
      });
    expect(spans(recreate(doc))).toEqual([[7, 11]]);
    // Same size, other text: the file changed while no editor held it.
    expect(spans(recreate(stateOf("hello WORLD big").doc))).toEqual([]);
  });

  it("forgets a widget's changes when it binds a new turn", () => {
    // Sending binds the turn first; its changes arrive while it is bound.
    updatePromptBlob(ROUND.blobId, { boundTurnId: ROUND.turnId });
    setDocumentPromptChanges(DOC_PATH, [
      { ...ROUND, from: 1, to: 3 },
      { blobId: "blob_b", turnId: "trn_9", from: 4, to: 5 },
    ]);
    // Anything but a new turn leaves them alone.
    updatePromptBlob(ROUND.blobId, { lastSentPrompt: "again" });
    expect(getDocumentPromptChanges(DOC_PATH)).toHaveLength(2);

    updatePromptBlob(ROUND.blobId, { boundTurnId: "trn_2" });
    expect(getDocumentPromptChanges(DOC_PATH)).toEqual([
      { blobId: "blob_b", turnId: "trn_9", from: 4, to: 5 },
    ]);
    expect(getPromptBlob(ROUND.blobId).boundTurnId).toBe("trn_2");
  });
});
