/**
 * Per-block `dir="auto"`: which blocks get it, and that it is worked out
 * once per document rather than on every view update — a selection change
 * used to walk the whole doc.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { autoDirectionKey, createSchemaExtensions } from "../editor-schema-kit";

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
  it("gives top-level paragraphs and headings dir=auto, not those a list item owns", () => {
    const target = editorWith(
      "<h1>Title</h1><p>Body</p><ul><li><p>Item</p></li></ul>",
    );
    const dom = target.view.dom;
    expect(dom.querySelector("h1")?.getAttribute("dir")).toBe("auto");
    expect(dom.querySelector(":scope > p")?.getAttribute("dir")).toBe("auto");
    expect(dom.querySelector("li > p")?.hasAttribute("dir")).toBe(false);
  });

  it("keeps its decorations across a selection-only change", () => {
    const target = editorWith("<p>One</p><p>Two</p>");
    const before = autoDirectionKey.getState(target.state);
    expect(before).toBeDefined();
    target.view.dispatch(
      target.state.tr.setSelection(TextSelection.create(target.state.doc, 1, 6)),
    );
    expect(autoDirectionKey.getState(target.state)).toBe(before);
  });

  it("decorates a paragraph added by an edit", () => {
    const target = editorWith("<p>One</p>");
    target.commands.insertContentAt(target.state.doc.content.size, "<p>Two</p>");
    const paragraphs = target.view.dom.querySelectorAll(":scope > p");
    expect(paragraphs).toHaveLength(2);
    paragraphs.forEach((p) => expect(p.getAttribute("dir")).toBe("auto"));
  });
});
