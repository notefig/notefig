/**
 * Prompt change tracking over a bare ProseMirror state: what a tagged
 * transaction records, how later edits move or drop it, and the store
 * round trip a recreated editor relies on.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Schema } from "@tiptap/pm/model";
import { EditorState, type Transaction } from "@tiptap/pm/state";
import { EditorView } from "@tiptap/pm/view";
import { PROMPT_NODE_NAME } from "../node";
import {
  PROMPT_CHANGE_META,
  createPromptReview,
  type PromptReview,
  type SavedReviewRanges,
} from "../change-store";
import {
  documentFingerprint,
  promptChangeTrackingPlugin,
  promptChangesOf,
} from "../change-tracking";
import { promptChangeMarks } from "../change-gutter";
import { testReviewRanges } from "../../testing/test-prompts";

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

/** The review store the plugin keeps its changes in — one per test. */
let review: PromptReview;
beforeEach(() => {
  review = createPromptReview(testReviewRanges());
});

function docOf(...blocks: Array<string | "widget">) {
  return schema.node(
    "doc",
    null,
    blocks.map((block) =>
      block === "widget"
        ? schema.node(PROMPT_NODE_NAME)
        : schema.node("paragraph", null, block ? schema.text(block) : []),
    ),
  );
}

function stateOf(...blocks: Array<string | "widget">) {
  return EditorState.create({
    doc: docOf(...blocks),
    plugins: [promptChangeTrackingPlugin(DOC_PATH, review)],
  });
}

const openAt = (documentPath: string, doc = docOf("hello world")) =>
  new EditorView(document.createElement("div"), {
    state: EditorState.create({
      doc,
      plugins: [promptChangeTrackingPlugin(documentPath, review)],
    }),
  });

function asRound(tr: Transaction): Transaction {
  return tr.setMeta(PROMPT_CHANGE_META, ROUND);
}

const spans = (state: EditorState) =>
  promptChangesOf(state).map(({ from, to }) => [from, to]);

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

  it("takes a closed document's changes back only onto the document they were mapped on", () => {
    const view = openAt(DOC_PATH);
    view.dispatch(asRound(view.state.tr.insertText("big ", 7)));
    expect(review.changes(DOC_PATH)).toHaveLength(1);
    const doc = view.state.doc;
    view.destroy();

    const reopened = openAt(DOC_PATH, doc);
    expect(spans(reopened.state)).toEqual([[7, 11]]);
    reopened.destroy();
    // Same size, other text: the file changed while no editor held it.
    const changed = openAt(DOC_PATH, docOf("hello WORLD big"));
    expect(spans(changed.state)).toEqual([]);
    // And the store follows: nothing left to count.
    expect(review.counts(ROUND.blobId)).toEqual(new Map());
    changed.destroy();
  });

  it("reviews one widget at a time, and ends a review whose changes are gone", () => {
    review.setReviewing(ROUND.blobId);
    review.setReviewing("blob_b");
    expect(review.reviewing()).toBe("blob_b");
    review.discard(ROUND.blobId);
    expect(review.reviewing()).toBe("blob_b");
    review.discard("blob_b");
    expect(review.reviewing()).toBeNull();
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

  /** A store over what an earlier run saved, once it has loaded. */
  const loaded = async (saved: Record<string, SavedReviewRanges>) => {
    review = createPromptReview(testReviewRanges(saved));
    await Promise.resolve();
  };
  const savedFor = (doc = docOf("hello world"), count = 1) => ({
    fingerprint: documentFingerprint(doc),
    changes: Array.from({ length: count }, (_, i) => ({
      ...ROUND,
      from: 1 + i,
      to: 2 + i,
    })),
  });

  it("takes up ranges that finish loading after the editor opened", async () => {
    let finishLoading = (_: ReadonlyMap<string, SavedReviewRanges>) => {};
    review = createPromptReview({
      ...testReviewRanges(),
      loadAll: () => new Promise((resolve) => (finishLoading = resolve)),
    });
    const view = openAt(DOC_PATH);
    expect(promptChangesOf(view.state)).toEqual([]);
    finishLoading(new Map([[DOC_PATH, savedFor()]]));
    await Promise.resolve();
    expect(spans(view.state)).toEqual([[1, 2]]);
    view.destroy();
  });

  it("counts a document's saved ranges until an editor opens it, then its live ones", async () => {
    await loaded({ [DOC_PATH]: savedFor(docOf("other"), 3), "/ws/closed.md": savedFor(undefined, 2) });
    expect(review.counts(ROUND.blobId)).toEqual(
      new Map([
        [DOC_PATH, 3],
        ["/ws/closed.md", 2],
      ]),
    );
    // Opened: the file changed while closed, so nothing is restored and
    // its saved count no longer stands for anything shown.
    const view = openAt(DOC_PATH);
    expect(review.counts(ROUND.blobId)).toEqual(new Map([["/ws/closed.md", 2]]));
    view.dispatch(asRound(view.state.tr.insertText("X", 1)));
    expect(review.counts(ROUND.blobId).get(DOC_PATH)).toBe(1);
    // Closed again, this run's ranges are still newer than the saved ones.
    view.destroy();
    expect(review.counts(ROUND.blobId).get(DOC_PATH)).toBe(1);
  });

  it("doesn't count saved ranges an editor rejected once it closes", async () => {
    await loaded({ [DOC_PATH]: savedFor(docOf("other"), 3) });
    openAt(DOC_PATH).destroy();
    expect(review.counts(ROUND.blobId)).toEqual(new Map());
  });

  it("saves a document's ranges only when they changed", () => {
    const store = testReviewRanges();
    const save = vi.spyOn(store, "save");
    review = createPromptReview(store);
    const ranges = savedFor();
    review.save(DOC_PATH, ranges);
    review.save(DOC_PATH, { ...ranges, changes: [...ranges.changes] });
    expect(save).toHaveBeenCalledTimes(1);
  });
});
