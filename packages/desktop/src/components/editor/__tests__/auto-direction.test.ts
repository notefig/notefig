/**
 * Per-block `dir="auto"` on the blocks that own a marker (list items,
 * quotes, table cells). Paragraphs and headings resolve their direction
 * in CSS (`unicode-bidi: plaintext`, tiptap.css), so they carry no `dir`:
 * one on a list item's paragraph would hide its text from the item's own
 * dir="auto" scan. The rendering itself is covered in the browser by
 * tests/e2e/rtl-direction.spec.ts.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import { createSchemaExtensions } from "../editor-schema-kit";

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

function editorWith(content: string): Editor {
  editor = new Editor({ extensions: createSchemaExtensions(), content });
  return editor;
}

describe("AutoDirection", () => {
  it("gives the blocks that own a marker dir=auto", () => {
    const dom = editorWith(
      "<ul><li><p>Item</p></li></ul><ol><li><p>One</p></li></ol>" +
        "<blockquote><p>Quote</p></blockquote>" +
        "<table><tr><th><p>H</p></th></tr><tr><td><p>C</p></td></tr></table>",
    ).view.dom;
    for (const selector of ["ul", "ol", "li", "blockquote", "th", "td"])
      expect(dom.querySelector(selector)?.getAttribute("dir"), selector).toBe(
        "auto",
      );
  });

  it("leaves paragraphs and headings without dir, wherever they are", () => {
    const dom = editorWith(
      "<h1>Title</h1><p>Body</p><ul><li><p>Item</p></li></ul>",
    ).view.dom;
    expect(dom.querySelectorAll("[dir]:is(p, h1)")).toHaveLength(0);
  });

  it("ignores a pasted dir on a wrapper", () => {
    const dom = editorWith('<blockquote dir="ltr"><p>Quote</p></blockquote>')
      .view.dom;
    expect(dom.querySelector("blockquote")?.getAttribute("dir")).toBe("auto");
  });
});
