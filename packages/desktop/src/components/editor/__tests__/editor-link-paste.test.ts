import { describe, it, expect, vi, beforeEach } from "vitest";
import { Editor } from "@tiptap/core";
import type { EditorView } from "@tiptap/pm/view";
import { editorExtensions } from "@/components/editor/tiptap-editor-kit";
import { createLinkPasteHandler } from "@/components/editor/editor-link-paste";

function createEditor(content = "Hello world") {
  return new Editor({ extensions: editorExtensions, content });
}

/** Minimal PM view stub: live state from the editor, dispatch through it. */
function stubView(editor: Editor): EditorView {
  return {
    get state() {
      return editor.state;
    },
    dispatch: (tr: unknown) => editor.view.dispatch(tr as never),
    posAtCoords: () => null,
  } as unknown as EditorView;
}

function pasteEvent(text: string): ClipboardEvent {
  return {
    preventDefault: vi.fn(),
    clipboardData: {
      getData: (type: string) => (type === "text/plain" ? text : ""),
    },
  } as unknown as ClipboardEvent;
}

function selectText(editor: Editor, from: number, to: number) {
  editor.chain().setTextSelection({ from, to }).run();
}

function findLinkHrefs(editor: Editor): string[] {
  const hrefs: string[] = [];
  editor.state.doc.descendants((node) => {
    const link = node.marks.find((mark) => mark.type.name === "link");
    if (link) hrefs.push(link.attrs.href as string);
  });
  return hrefs;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createLinkPasteHandler", () => {
  it("turns the selected text into a link when pasting a URL", () => {
    const editor = createEditor("Hello world");
    const handler = createLinkPasteHandler();
    selectText(editor, 1, 6); // "Hello"
    const event = pasteEvent("https://example.com");

    const handled = handler(stubView(editor), event);

    expect(handled).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(findLinkHrefs(editor)).toEqual(["https://example.com"]);
    expect(editor.state.doc.textContent).toBe("Hello world");
    editor.destroy();
  });

  it("supports mailto links", () => {
    const editor = createEditor("Email me");
    const handler = createLinkPasteHandler();
    selectText(editor, 1, 9);
    const event = pasteEvent("mailto:test@example.com");

    expect(handler(stubView(editor), event)).toBe(true);
    expect(findLinkHrefs(editor)).toEqual(["mailto:test@example.com"]);
    editor.destroy();
  });

  it("trims whitespace from the pasted URL", () => {
    const editor = createEditor("Hello world");
    const handler = createLinkPasteHandler();
    selectText(editor, 1, 6);
    const event = pasteEvent("  https://example.com  ");

    handler(stubView(editor), event);

    expect(findLinkHrefs(editor)).toEqual(["https://example.com"]);
    editor.destroy();
  });

  it("ignores pasted text that is not a URL", () => {
    const editor = createEditor("Hello world");
    const handler = createLinkPasteHandler();
    selectText(editor, 1, 6);
    const event = pasteEvent("not a url");

    const handled = handler(stubView(editor), event);

    expect(handled).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(findLinkHrefs(editor)).toEqual([]);
    editor.destroy();
  });

  it("ignores URL paste when the selection is empty", () => {
    const editor = createEditor("Hello world");
    const handler = createLinkPasteHandler();
    editor.commands.setTextSelection(6); // collapsed cursor
    const event = pasteEvent("https://example.com");

    const handled = handler(stubView(editor), event);

    expect(handled).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(findLinkHrefs(editor)).toEqual([]);
    editor.destroy();
  });

  it("ignores paste when the clipboard has no text", () => {
    const editor = createEditor("Hello world");
    const handler = createLinkPasteHandler();
    selectText(editor, 1, 6);
    const event = pasteEvent("");

    expect(handler(stubView(editor), event)).toBe(false);
    expect(findLinkHrefs(editor)).toEqual([]);
    editor.destroy();
  });
});
