/**
 * Session colors (MET-284): a slot maps to its theme token, the review
 * carries the reviewed widget's slot, and the gutter draws that widget's
 * change marks in it — or in the neutral color when there is none.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { Schema } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { EditorView } from "@tiptap/pm/view";
import { PROMPT_CHANGE_META, createPromptReview, type PromptReview } from "../change-store";
import { promptChangeTrackingPlugin } from "../change-tracking";
import { promptChangeGutterPlugin } from "../change-gutter";
import { sessionColor } from "../session-color";
import { testReviewRanges } from "../../testing/test-prompts";

describe("sessionColor", () => {
  it("maps a slot to its theme token, and no slot to the neutral color", () => {
    expect(sessionColor(0)).toBe("hsl(var(--session-1))");
    expect(sessionColor(5, 0.25)).toBe("hsl(var(--session-6) / 0.25)");
    expect(sessionColor(undefined)).toBe("hsl(var(--muted-foreground))");
    expect(sessionColor(null, 0.25)).toBe("hsl(var(--muted-foreground) / 0.25)");
  });
});

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "text*", toDOM: () => ["p", 0] },
    text: {},
  },
});
const DOC_PATH = "/ws/notes.md";
const ROUND = { blobId: "blob_a", turnId: "trn_1" };

let review: PromptReview;
let view: EditorView;
beforeEach(() => {
  review = createPromptReview(testReviewRanges());
  const host = document.createElement("div");
  document.body.append(host);
  view = new EditorView(host, {
    state: EditorState.create({
      doc: schema.node("doc", null, [schema.node("paragraph", null, schema.text("hello world"))]),
      plugins: [promptChangeTrackingPlugin(DOC_PATH, review), promptChangeGutterPlugin(review)],
    }),
  });
  view.dispatch(view.state.tr.insertText("big ", 7).setMeta(PROMPT_CHANGE_META, ROUND));
});

const bars = () =>
  [...document.querySelectorAll<HTMLElement>("[data-prompt-change-mark]")].map((bar) =>
    bar.style.getPropertyValue("--prompt-change"),
  );

describe("change marks in the session's color", () => {
  it("draws the reviewed widget's marks in its session's slot", () => {
    review.setReviewing(ROUND.blobId, 2);
    expect(review.reviewingSlot()).toBe(2);
    expect(bars()).toEqual(["hsl(var(--session-3))"]);
    view.destroy();
  });

  it("redraws when the same widget is reviewed under another session's slot", () => {
    review.setReviewing(ROUND.blobId, 2);
    review.setReviewing(ROUND.blobId, 4);
    expect(bars()).toEqual(["hsl(var(--session-5))"]);
    view.destroy();
  });

  it("draws in the neutral color when the widget's session has no slot", () => {
    review.setReviewing(ROUND.blobId);
    expect(review.reviewingSlot()).toBeNull();
    expect(bars()).toEqual(["hsl(var(--muted-foreground))"]);
    view.destroy();
  });

  it("forgets the slot when the review ends", () => {
    review.setReviewing(ROUND.blobId, 2);
    review.setReviewing(null, 2);
    expect(review.reviewingSlot()).toBeNull();
    expect(bars()).toEqual([]);
    view.destroy();
  });
});
