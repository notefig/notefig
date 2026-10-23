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
  countPromptChanges,
  discardPromptChanges,
  getDocumentPromptChanges,
  getPromptReview,
  setDocumentPromptChanges,
  setPromptReview,
} from "../change-store";
import {
  documentFingerprint,
  promptChangeTrackingPlugin,
  promptChangesOf,
} from "../change-tracking";
import {
  createPromptWidgets,
  inertPromptWidgets,
  type SavedReviewRanges,
} from "../widgets-service";
import { promptChangeMarks } from "../change-gutter";

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

/** The service the plugin keeps its review ranges with — one per test. */
let prompts = inertPromptWidgets();

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
    plugins: [promptChangeTrackingPlugin(DOC_PATH, prompts)],
  });
}

function asRound(tr: Transaction): Transaction {
  return tr.setMeta(PROMPT_CHANGE_META, ROUND);
}

const spans = (state: EditorState) =>
  promptChangesOf(state).map(({ from, to }) => [from, to]);

afterEach(() => {
  prompts = inertPromptWidgets();
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
    expect(promptChangesOf(state)).toEqual([{ ...ROUND, from: 7, to: 11 }]);
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

  it("marks each changed block once in the gutter; a removed block has none", () => {
    let state = stateOf("one", "two", "three");
    // Two edits in "one", then the "two" paragraph removed outright.
    state = state.apply(
      asRound(state.tr.insertText("1", 1, 2).insertText("E", 3, 4)),
    );
    state = state.apply(asRound(state.tr.delete(5, 10)));
    expect(promptChangeMarks(state)).toEqual([{ pos: 0, blobId: ROUND.blobId }]);
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
        plugins: [promptChangeTrackingPlugin(DOC_PATH, prompts)],
      });
    expect(spans(recreate(doc))).toEqual([[7, 11]]);
    // Same size, other text: the file changed while no editor held it.
    const changed = recreate(stateOf("hello WORLD big").doc);
    expect(spans(changed)).toEqual([]);
    // Mounting it clears what it could not restore.
    new EditorView(document.createElement("div"), { state: changed }).destroy();
    expect(getDocumentPromptChanges(DOC_PATH)).toEqual([]);
  });

  it("reviews one widget at a time, and ends a review whose changes are gone", () => {
    setPromptReview(ROUND.blobId);
    setPromptReview("blob_b");
    expect(getPromptReview()).toBe("blob_b");
    discardPromptChanges(ROUND.blobId);
    expect(getPromptReview()).toBe("blob_b");
    discardPromptChanges("blob_b");
    expect(getPromptReview()).toBeNull();
  });
});

describe("saved review ranges", () => {
  const nested = new Schema({
    nodes: {
      doc: { content: "block+" },
      paragraph: { group: "block", content: "text*" },
      blockquote: { group: "block", content: "block+" },
      text: {},
    },
  });
  const p = (text: string) => nested.node("paragraph", null, [nested.text(text)]);
  const quote = (...children: ReturnType<typeof p>[]) =>
    nested.node("blockquote", null, children);

  it("fingerprints structure, not just the text in order", () => {
    // Same text, same node types in the same order — a paragraph inside
    // the quote vs after it shifts every later position by one.
    const inside = nested.node("doc", null, [quote(p("a"), p("b"))]);
    const after = nested.node("doc", null, [quote(p("a")), p("b")]);
    expect(documentFingerprint(inside)).not.toBe(documentFingerprint(after));
    expect(documentFingerprint(inside)).toBe(
      documentFingerprint(nested.node("doc", null, [quote(p("a"), p("b"))])),
    );
  });

  it("takes up ranges that are saved after the editor opened", () => {
    let saved: SavedReviewRanges | null = null;
    const listeners = new Set<() => void>();
    const service = createPromptWidgets({
      observeRound: () => ({
        get: () => ({
          turn: undefined,
          task: undefined,
          taskTurns: [],
          hasPendingPermission: false,
          entries: [],
        }),
        destroy: () => {},
      }),
      reviewRanges: {
        load: () => saved,
        save: () => {},
        forget: () => {},
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    });
    const state = EditorState.create({
      doc: schema.node("doc", null, [schema.node("paragraph", null, [schema.text("hello world")])]),
      plugins: [promptChangeTrackingPlugin(DOC_PATH, service)],
    });
    const view = new EditorView(document.createElement("div"), { state });
    expect(promptChangesOf(view.state)).toEqual([]);
    // The app's stored rows finish loading.
    saved = {
      fingerprint: documentFingerprint(view.state.doc),
      changes: [{ ...ROUND, from: 1, to: 6 }],
    };
    for (const listener of listeners) listener();
    expect(spans(view.state)).toEqual([[1, 6]]);
    view.destroy();
  });

  // The store outlives each test, so these open documents no other test has.
  const openedAt = (documentPath: string) =>
    new EditorView(document.createElement("div"), {
      state: EditorState.create({
        doc: schema.node("doc", null, [schema.node("paragraph", null, [schema.text("hello world")])]),
        plugins: [promptChangeTrackingPlugin(documentPath, prompts)],
      }),
    });

  it("counts a document's saved ranges until an editor opens it, then its live ones", () => {
    const opened = "/ws/counted.md";
    const saved = { [opened]: 3, "/ws/closed.md": 2 };
    expect(countPromptChanges(ROUND.blobId, saved)).toEqual(
      new Map([
        [opened, 3],
        ["/ws/closed.md", 2],
      ]),
    );
    // Opened: the editor restored nothing (the file changed while closed),
    // so its saved count no longer stands for anything shown.
    const view = openedAt(opened);
    expect(countPromptChanges(ROUND.blobId, saved)).toEqual(
      new Map([["/ws/closed.md", 2]]),
    );
    view.dispatch(asRound(view.state.tr.insertText("X", 1)));
    expect(countPromptChanges(ROUND.blobId, saved)).toEqual(
      new Map([
        ["/ws/closed.md", 2],
        [opened, 1],
      ]),
    );
    // Closed again, this run's ranges are still newer than the saved ones.
    view.destroy();
    expect(countPromptChanges(ROUND.blobId, saved).get(opened)).toBe(1);
  });

  it("doesn't count saved ranges an editor rejected once it closes", () => {
    const rejected = "/ws/rejected.md";
    const saved = { [rejected]: 3 };
    openedAt(rejected).destroy();
    expect(countPromptChanges(ROUND.blobId, saved)).toEqual(new Map());
  });
});
