/**
 * Repro: deleting the prompt widget's draft text must never delete the
 * widget itself.
 *
 * Unlike ai-prompt-node.test.ts (schema-level, no React), this mounts the
 * editor through EditorContent so the React node view — and with it the
 * PromptBlob whose useComposerKeys handler owns Backspace — is really
 * running, exactly as in the app.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";

// react-i18next resolves the hoisted root React copy under vitest (hooks
// break across instances); the widget only uses it for labels, so stub it.
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
    // The keeper/summon plumbing and the widget's effects settle a tick
    // after create (same wait ai-prompt-node.test.ts uses).
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(editor).not.toBeNull();
  return editor!;
}

/** One typed character, through the view's handleTextInput chain (the "/"
 *  summon lives there). */
function typeText(editor: Editor, text: string): boolean {
  const { from, to } = editor.state.selection;
  const defaultInsert = () => editor.state.tr.insertText(text, from, to);
  return Boolean(
    editor.view.someProp("handleTextInput", (handler) =>
      handler(editor.view, from, to, text, defaultInsert),
    ),
  );
}

/** One real keydown dispatched at the editor DOM, so the whole delivery
 *  path runs: the key-bridge's capture-phase repeat tracker, then
 *  ProseMirror's handler and every keymap/plugin. Deliberately NO
 *  simulated browser default: an in-draft Backspace the chain does not
 *  consume reaches the browser's native contenteditable editing in the
 *  real app, and WebKit's native delete inside the widget's editable
 *  island is exactly the mangling this suite guards against — so the
 *  tests assert consumption (preventDefault), and any deletion must
 *  appear in the ProseMirror doc itself. */
function pressKey(
  editor: Editor,
  key: string,
  options: { repeat?: boolean } = {},
): { handled: boolean } {
  const event = new KeyboardEvent("keydown", {
    key,
    repeat: options.repeat ?? false,
    bubbles: true,
    cancelable: true,
  });
  editor.view.dom.dispatchEvent(event);
  return { handled: event.defaultPrevented };
}

/** The widget draft's current text, read off the document. */
function draftText(editor: Editor): string | null {
  let text: string | null = null;
  editor.state.doc.descendants((node) => {
    if (node.type.name === "aiPrompt") {
      text = node.firstChild?.textContent ?? "";
      return false;
    }
    return text === null;
  });
  return text;
}

function hasWidget(editor: Editor): boolean {
  let found = false;
  editor.state.doc.descendants((node) => {
    if (node.type.name === "aiPrompt") found = true;
    return !found;
  });
  return found;
}

/** Summon a widget with "/" and leave the caret in its draft. */
async function summonWidget(editor: Editor): Promise<void> {
  await act(async () => {
    editor.commands.setTextSelection(11); // the empty second paragraph
    typeText(editor, "/");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(hasWidget(editor)).toBe(true);
  expect(selectionDraft(editor.state)).toBeTruthy();
}

describe("deleting draft characters never deletes the widget", () => {
  it("a single character deleted with Backspace leaves the widget standing", async () => {
    const editor = await mountedEditor("<p>Hi there</p><p></p>");
    await summonWidget(editor);
    await act(async () => {
      editor.commands.insertContent("x");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(selectionDraft(editor.state)?.blobId).toBeTruthy();
    expect(draftText(editor)).toBe("x");

    let handled = false;
    await act(async () => {
      handled = pressKey(editor, "Backspace").handled;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Consumed — the browser's native editing (whose in-island delete is
    // what mangles the widget in WebKit) must never see the key — and the
    // deletion itself lands as a ProseMirror transaction.
    expect(handled).toBe(true);
    expect(draftText(editor)).toBe("");
    // The character goes; the widget stays, caret still in its draft.
    expect(hasWidget(editor)).toBe(true);
    expect(selectionDraft(editor.state)).toBeTruthy();
  });

  it("a Backspace on the already-empty draft dismisses the widget", async () => {
    const editor = await mountedEditor("<p>Hi there</p><p></p>");
    await summonWidget(editor);
    await act(async () => {
      editor.commands.insertContent("x");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await act(async () => {
      pressKey(editor, "Backspace"); // deletes "x"
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      pressKey(editor, "Backspace"); // draft is empty now: dismiss
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(hasWidget(editor)).toBe(false);
  });

  it('a "/" on the already-empty draft reverts the widget to a literal slash', async () => {
    const editor = await mountedEditor("<p>Hi there</p><p></p>");
    await summonWidget(editor);
    await act(async () => {
      editor.commands.insertContent("x");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await act(async () => {
      pressKey(editor, "Backspace"); // deletes "x"
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      pressKey(editor, "/");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(hasWidget(editor)).toBe(false);
    expect(editor.state.doc.textContent).toContain("/");
  });

  it("a pristine summoned widget still reverts on Backspace (the '/' undo)", async () => {
    const editor = await mountedEditor("<p>Hi there</p><p></p>");
    await summonWidget(editor);

    await act(async () => {
      pressKey(editor, "Backspace"); // never typed into: dismiss is correct
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(hasWidget(editor)).toBe(false);
  });
});
