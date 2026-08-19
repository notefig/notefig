import { describe, expect, it } from "vitest";
import { handoffSatisfied } from "../prerender";

function element(text: string): Element {
  const node = document.createElement("div");
  node.textContent = text;
  return node;
}

describe("handoffSatisfied", () => {
  it("waits until the app has painted the page's text", () => {
    expect(handoffSatisfied(null, false)).toBe(false);
    expect(handoffSatisfied(element(""), false)).toBe(false);
    expect(handoffSatisfied(element("   \n "), false)).toBe(false);
    expect(handoffSatisfied(element("# CLI"), false)).toBe(true);
  });

  it("accepts an empty editor for a page the visitor emptied", () => {
    // Their edits persist, so after a reload there is no text to wait for.
    // Without this the overlay only lifts on the 15s timeout, and until then
    // a stale snapshot sits over the app: no scrolling, no file tree.
    expect(handoffSatisfied(element(""), true)).toBe(true);
  });

  it("still needs the editor to exist", () => {
    expect(handoffSatisfied(null, true)).toBe(false);
  });
});
