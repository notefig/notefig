import { describe, it, expect, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import { editorExtensions } from "../tiptap-editor-kit";
import {
  extractOutline,
  nearestPrecedingHeading,
  windowAroundPos,
} from "../document-outline";

const editors: Editor[] = [];

function docFor(markdown: string) {
  const editor = new Editor({
    extensions: editorExtensions,
    content: markdown,
    editable: true,
    autofocus: false,
  });
  editors.push(editor);
  return editor.state.doc;
}

afterEach(() => {
  editors.forEach((e) => e.destroy());
  editors.length = 0;
});

describe("extractOutline", () => {
  it("returns headings in document order with correct levels", () => {
    const doc = docFor("# One\n\nbody\n\n## Two\n\nmore\n\n### Three");
    const outline = extractOutline(doc);
    expect(outline.map((h) => ({ level: h.level, text: h.text }))).toEqual([
      { level: 1, text: "One" },
      { level: 2, text: "Two" },
      { level: 3, text: "Three" },
    ]);
  });

  it("returns an empty array when there are no headings", () => {
    const doc = docFor("just a paragraph");
    expect(extractOutline(doc)).toEqual([]);
  });
});

describe("nearestPrecedingHeading", () => {
  it("returns null before the first heading", () => {
    const doc = docFor("intro text\n\n# First");
    const firstHeadingPos = extractOutline(doc)[0].pos;
    expect(nearestPrecedingHeading(doc, firstHeadingPos - 1)).toBeNull();
  });

  it("returns the correct heading mid-section", () => {
    const doc = docFor("# One\n\nbody one\n\n## Two\n\nbody two");
    const outline = extractOutline(doc);
    const midSecondSection = doc.content.size - 1;
    expect(nearestPrecedingHeading(doc, midSecondSection)?.text).toBe("Two");
    expect(nearestPrecedingHeading(doc, outline[0].pos)?.text).toBe("One");
  });

  it("updates correctly across heading-level changes", () => {
    const doc = docFor("# H1\n\n## H2 under H1\n\n# H1 again");
    const outline = extractOutline(doc);
    const [h1, h2, h1Again] = outline;
    expect(nearestPrecedingHeading(doc, h2.pos)?.text).toBe("H2 under H1");
    expect(nearestPrecedingHeading(doc, h1Again.pos)?.text).toBe("H1 again");
    expect(nearestPrecedingHeading(doc, h1.pos)?.text).toBe("H1");
  });
});

describe("windowAroundPos", () => {
  it("bounds the window to maxChars", () => {
    const long = Array.from({ length: 50 }, (_, i) => `paragraph ${i}`).join(
      "\n\n",
    );
    const doc = docFor(long);
    const mid = Math.floor(doc.content.size / 2);
    const window = windowAroundPos(doc, mid, 100);
    expect(window.length).toBeLessThanOrEqual(100);
  });

  it("clamps a pos beyond the doc's current size instead of throwing", () => {
    const doc = docFor("short doc");
    expect(() => windowAroundPos(doc, doc.content.size + 500)).not.toThrow();
  });

  it("clamps a negative pos instead of throwing", () => {
    const doc = docFor("short doc");
    expect(() => windowAroundPos(doc, -50)).not.toThrow();
  });

  it("handles pos at doc start", () => {
    const doc = docFor("hello world");
    const window = windowAroundPos(doc, 0, 100);
    expect(window).toContain("hello world");
  });
});
