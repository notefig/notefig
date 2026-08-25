import { describe, expect, it } from "vitest";
import { handoffSatisfied, marketingHandoff } from "../prerender";

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

  it("waits until a product-shot image has loaded", () => {
    const img = document.createElement("img");
    Object.defineProperty(img, "complete", { configurable: true, value: false });
    expect(handoffSatisfied(img, false)).toBe(false);
    Object.defineProperty(img, "complete", { configurable: true, value: true });
    expect(handoffSatisfied(img, false)).toBe(true);
  });
});

describe("marketingHandoff", () => {
  it("waits on the screenshot on mobile, without treating it as empty text", () => {
    expect(marketingHandoff(true, false, false)).toEqual({
      selector: ".product-shot",
      allowEmpty: false,
    });
  });

  it("waits on the editor once the desktop workspace is ready", () => {
    expect(marketingHandoff(false, true, false)).toEqual({
      selector: ".ProseMirror",
      allowEmpty: false,
    });
    expect(marketingHandoff(false, true, true).allowEmpty).toBe(true);
    expect(marketingHandoff(false, false, false).selector).toBe(".never");
  });
});
