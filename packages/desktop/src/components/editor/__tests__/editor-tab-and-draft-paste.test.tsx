/**
 * MET-198: two keys that used to leave the document behind.
 *
 *  - Tab in prose fell through to the browser's focus navigation (landing
 *    on the first toolbar / widget button). The TabGuard extension swallows
 *    the fall-through while list indent still runs ahead of it.
 *  - A multi-line paste into a prompt widget's draft was block-fitted out
 *    of the widget. The widget's handlePaste flattens it into the draft.
 *
 * Mounted through EditorContent like prompt-widget-backspace.test.tsx so
 * the React node view (and the composer key map it owns) is really running.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty" as const, init: () => {} },
}));

import { Editor, EditorContent, useEditor } from "@tiptap/react";
import { editorExtensions } from "@/components/editor/tiptap-editor-kit";
import { widgetRendererNodes, selectionDraft } from "@notefig/widgets";
import { fakePromptWidgetHost, withHost } from "@notefig/widgets/testing";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

function Harness({
  content,
  onEditor,
}: {
  content: string;
  onEditor: (editor: Editor) => void;
}) {
  const editor = useEditor({
    extensions: [
      ...editorExtensions.filter((e) => e.name !== "aiPrompt"),
      ...widgetRendererNodes({ filePath: "/ws/doc.md", basePath: "/ws" }),
    ],
    content,
  });
  useEffect(() => {
    if (editor) onEditor(editor);
  }, [editor, onEditor]);
  return editor ? createElement(EditorContent, { editor }) : null;
}

async function mountedEditor(content: string): Promise<Editor> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  let editor: Editor | null = null;
  await act(async () => {
    root!.render(
      withHost(
        fakePromptWidgetHost(),
        createElement(Harness, {
          content,
          onEditor: (instance) => {
            editor = instance;
          },
        }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(editor).not.toBeNull();
  return editor!;
}

function typeText(editor: Editor, text: string): boolean {
  const { from, to } = editor.state.selection;
  const defaultInsert = () => editor.state.tr.insertText(text, from, to);
  return Boolean(
    editor.view.someProp("handleTextInput", (handler) =>
      handler(editor.view, from, to, text, defaultInsert),
    ),
  );
}

/** A real keydown at the editor DOM; `handled` is whether the chain
 *  consumed it (the browser default — focus navigation for Tab — would
 *  run otherwise). */
function pressKey(
  editor: Editor,
  key: string,
  options: { shiftKey?: boolean } = {},
): { handled: boolean } {
  const event = new KeyboardEvent("keydown", {
    key,
    shiftKey: options.shiftKey ?? false,
    bubbles: true,
    cancelable: true,
  });
  editor.view.dom.dispatchEvent(event);
  return { handled: event.defaultPrevented };
}

/** A paste at the editor DOM carrying plain text. happy-dom's
 *  ClipboardEvent can't be handed a DataTransfer, so the field is defined
 *  by hand with the two members ProseMirror reads. */
function paste(editor: Editor, text: string): { handled: boolean } {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      getData: (type: string) => (type === "text/plain" ? text : ""),
      types: ["text/plain"],
      files: [],
      items: [],
    },
  });
  editor.view.dom.dispatchEvent(event);
  return { handled: event.defaultPrevented };
}

function widgets(editor: Editor): { draft: string }[] {
  const found: { draft: string }[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name !== "aiPrompt") return true;
    found.push({ draft: node.firstChild?.textContent ?? "" });
    return false;
  });
  return found;
}

async function summonWidget(editor: Editor): Promise<void> {
  await act(async () => {
    editor.commands.setTextSelection(11); // the empty second paragraph
    typeText(editor, "/");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(widgets(editor)).toHaveLength(1);
  expect(selectionDraft(editor.state)).toBeTruthy();
}

describe("Tab stays in the document (MET-198)", () => {
  it("is consumed in prose, with the document unchanged", async () => {
    const editor = await mountedEditor("<p>Hi there</p><p></p>");
    const before = editor.state.doc.toJSON();
    editor.commands.setTextSelection(3);
    expect(pressKey(editor, "Tab").handled).toBe(true);
    expect(pressKey(editor, "Tab", { shiftKey: true }).handled).toBe(true);
    expect(editor.state.doc.toJSON()).toEqual(before);
  });

  it("still indents a list item ahead of the guard", async () => {
    const editor = await mountedEditor("<ul><li>one</li><li>two</li></ul>");
    editor.commands.setTextSelection(editor.state.doc.content.size - 3);
    expect(pressKey(editor, "Tab").handled).toBe(true);
    // "two" nested one level under "one": the ListItem keymap ran first.
    expect(editor.getHTML()).toMatch(
      /<li[^>]*><p>one<\/p><ul[^>]*><li[^>]*><p>two<\/p><\/li><\/ul><\/li>/,
    );
  });

  it("is consumed inside a widget draft too", async () => {
    const editor = await mountedEditor("<p>Hi there</p><p></p>");
    await summonWidget(editor);
    expect(pressKey(editor, "Tab").handled).toBe(true);
    expect(selectionDraft(editor.state)).toBeTruthy();
  });
});

describe("multi-line paste into a widget draft (MET-198)", () => {
  it("flattens line breaks and keeps everything inside the draft", async () => {
    const editor = await mountedEditor("<p>Hi there</p><p></p>");
    await summonWidget(editor);
    const blocksBefore = editor.state.doc.childCount;

    let handled = false;
    await act(async () => {
      handled = paste(editor, "first\nsecond\r\n\nthird").handled;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handled).toBe(true);
    expect(widgets(editor)).toEqual([{ draft: "first second third" }]);
    expect(editor.state.doc.childCount).toBe(blocksBefore);
    expect(selectionDraft(editor.state)).toBeTruthy();
  });

  it("leaves a paste into ordinary prose to the editor", async () => {
    const editor = await mountedEditor("<p>Hi there</p><p></p>");
    editor.commands.setTextSelection(11);
    await act(async () => {
      paste(editor, "alpha\nbeta");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // Two lines become two blocks — the widget plugin did not flatten them.
    expect(editor.state.doc.textContent).toContain("alpha");
    expect(editor.state.doc.textContent).toContain("beta");
    expect(editor.state.doc.textContent).not.toContain("alpha beta");
  });
});
