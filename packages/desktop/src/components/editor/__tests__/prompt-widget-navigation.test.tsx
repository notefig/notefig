/**
 * Keyboard navigation across prompt widgets in a document (MET-283).
 *
 * Tests the navigation helper directly over a mounted editor; the hotkey
 * wiring itself is a thin `useHotkey` wrapper and is covered by the
 * component-level spec in tests/editor/markdown-editor.spec.ts.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { StrictMode, act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
  initReactI18next: { type: "3rdParty" as const, init: () => {} },
}));

import { Editor, EditorContent, useEditor } from "@tiptap/react";
import { NodeSelection } from "@tiptap/pm/state";
import { editorExtensions } from "@/components/editor/tiptap-editor-kit";
import { widgetRendererNodes } from "@notefig/widgets";
import {
  fakePromptWidgetHost,
  testPrompts,
  withHost,
} from "@notefig/widgets/testing";
import type { DictationApi } from "@notefig/dictation";
import {
  navigateToPromptWidget,
  usePromptWidgetNavigation,
} from "../use-prompt-widget-navigation";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

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
      ...widgetRendererNodes({
        filePath: "/ws/doc.md",
        basePath: "/ws",
        prompts: testPrompts().prompts,
      }),
    ],
    content,
  });
  useEffect(() => {
    if (editor) onEditor(editor);
  }, [editor, onEditor]);
  return editor ? createElement(EditorContent, { editor }) : null;
}

async function mount(content: string): Promise<Editor> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  let editor: Editor | null = null;
  await act(async () => {
    root!.render(
      createElement(
        StrictMode,
        null,
        withHost(
          fakePromptWidgetHost(),
          createElement(Harness, {
            content,
            onEditor: (instance) => {
              editor = instance;
            },
          }),
        ),
      ),
    );
    await tick();
  });
  return editor!;
}

async function navigate(
  editor: Editor,
  direction: "next" | "prev" | "first" | "last",
): Promise<void> {
  await act(async () => {
    navigateToPromptWidget(editor, direction);
    await tick();
  });
}

function NavigationHarness({
  content,
  onEditor,
  dictation,
}: {
  content: string;
  onEditor: (editor: Editor) => void;
  dictation?: DictationApi;
}) {
  const editor = useEditor({
    extensions: [
      ...editorExtensions.filter((e) => e.name !== "aiPrompt"),
      ...widgetRendererNodes({
        filePath: "/ws/doc.md",
        basePath: "/ws",
        prompts: testPrompts().prompts,
      }),
    ],
    content,
  });
  useEffect(() => {
    if (editor) onEditor(editor);
  }, [editor, onEditor]);
  usePromptWidgetNavigation(editor, dictation);
  return editor ? createElement(EditorContent, { editor }) : null;
}

async function mountWithDictation(
  content: string,
  dictation?: DictationApi,
): Promise<Editor> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  let editor: Editor | null = null;
  await act(async () => {
    root!.render(
      createElement(
        StrictMode,
        null,
        withHost(
          fakePromptWidgetHost(),
          createElement(NavigationHarness, {
            content,
            onEditor: (instance) => {
              editor = instance;
            },
            dictation,
          }),
        ),
      ),
    );
    await tick();
  });
  return editor!;
}

function widgetPositions(editor: Editor): { pos: number; blobId: string }[] {
  const found: { pos: number; blobId: string }[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "aiPrompt") {
      found.push({ pos, blobId: node.attrs.blobId as string });
      return false;
    }
    return true;
  });
  return found;
}

function selectedParentName(editor: Editor): string {
  return editor.state.selection.$from.parent.type.name;
}

function selectedBlobId(editor: Editor): string | null {
  const sel = editor.state.selection;
  if (sel instanceof NodeSelection && sel.node.type.name === "aiPrompt") {
    return sel.node.attrs.blobId as string;
  }
  const { $from } = sel;
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (node.type.name === "aiPrompt") {
      return node.attrs.blobId as string;
    }
  }
  return null;
}

describe("navigateToPromptWidget", () => {
  it("does nothing in a document with no widgets", async () => {
    const editor = await mount("<p>no widgets here</p>");
    editor.commands.setTextSelection(1);
    expect(navigateToPromptWidget(editor, "next")).toBe(false);
    expect(selectedParentName(editor)).toBe("paragraph");
  });

  it("moves the caret into the first widget when there is only one", async () => {
    const editor = await mount(
      '<p>before</p><div data-type="ai-prompt" data-blob-id="blob_a"></div><p>after</p>',
    );
    editor.commands.setTextSelection(1);

    expect(navigateToPromptWidget(editor, "next")).toBe(true);
    expect(selectedBlobId(editor)).toBe("blob_a");
  });

  it("cycles forward through widgets and wraps to the first", async () => {
    const editor = await mount(
      [
        "<p>start</p>",
        '<div data-type="ai-prompt" data-blob-id="blob_a"></div>',
        "<p>between</p>",
        '<div data-type="ai-prompt" data-blob-id="blob_b"></div>',
        "<p>between</p>",
        '<div data-type="ai-prompt" data-blob-id="blob_c"></div>',
      ].join(""),
    );
    const [a] = widgetPositions(editor);

    // Caret in the leading paragraph, before the first widget.
    editor.commands.setTextSelection(a.pos - 2);
    expect(selectedParentName(editor)).toBe("paragraph");

    await navigate(editor, "next");
    expect(selectedBlobId(editor)).toBe("blob_a");

    await navigate(editor, "next");
    expect(selectedBlobId(editor)).toBe("blob_b");

    await navigate(editor, "next");
    expect(selectedBlobId(editor)).toBe("blob_c");

    await navigate(editor, "next");
    expect(selectedBlobId(editor)).toBe("blob_a");
  });

  it("cycles backward and wraps to the last", async () => {
    const editor = await mount(
      [
        '<div data-type="ai-prompt" data-blob-id="blob_a"></div>',
        "<p>between</p>",
        '<div data-type="ai-prompt" data-blob-id="blob_b"></div>',
        "<p>end</p>",
      ].join(""),
    );

    // Caret in the trailing paragraph, after the last widget.
    editor.commands.setTextSelection(editor.state.doc.content.size - 2);
    expect(selectedParentName(editor)).toBe("paragraph");

    await navigate(editor, "prev");
    expect(selectedBlobId(editor)).toBe("blob_b");

    await navigate(editor, "prev");
    expect(selectedBlobId(editor)).toBe("blob_a");

    await navigate(editor, "prev");
    expect(selectedBlobId(editor)).toBe("blob_b");
  });

  it("jumps from inside a widget to the next one", async () => {
    const editor = await mount(
      [
        '<div data-type="ai-prompt" data-blob-id="blob_a"></div>',
        "<p>between</p>",
        '<div data-type="ai-prompt" data-blob-id="blob_b"></div>',
      ].join(""),
    );
    const [a] = widgetPositions(editor);

    // Start with the caret inside the first widget's draft.
    editor.commands.setTextSelection(a.pos + 2);
    expect(selectedBlobId(editor)).toBe("blob_a");

    await navigate(editor, "next");
    expect(selectedBlobId(editor)).toBe("blob_b");
  });

  it("jumps from inside a widget to the previous one", async () => {
    const editor = await mount(
      [
        '<div data-type="ai-prompt" data-blob-id="blob_a"></div>',
        "<p>between</p>",
        '<div data-type="ai-prompt" data-blob-id="blob_b"></div>',
      ].join(""),
    );
    const [, b] = widgetPositions(editor);

    editor.commands.setTextSelection(b.pos + 2);
    expect(selectedBlobId(editor)).toBe("blob_b");

    await navigate(editor, "prev");
    expect(selectedBlobId(editor)).toBe("blob_a");
  });

  it("repeated navigation from inside a widget wraps correctly", async () => {
    const editor = await mount(
      [
        '<div data-type="ai-prompt" data-blob-id="blob_a"></div>',
        "<p>between</p>",
        '<div data-type="ai-prompt" data-blob-id="blob_b"></div>',
      ].join(""),
    );
    const [a] = widgetPositions(editor);

    editor.commands.setTextSelection(a.pos + 2);
    expect(selectedBlobId(editor)).toBe("blob_a");

    await navigate(editor, "prev");
    expect(selectedBlobId(editor)).toBe("blob_b");

    await navigate(editor, "prev");
    expect(selectedBlobId(editor)).toBe("blob_a");
  });

  it("first and last jump regardless of current position", async () => {
    const editor = await mount(
      [
        '<div data-type="ai-prompt" data-blob-id="blob_a"></div>',
        "<p>between</p>",
        '<div data-type="ai-prompt" data-blob-id="blob_b"></div>',
        "<p>between</p>",
        '<div data-type="ai-prompt" data-blob-id="blob_c"></div>',
      ].join(""),
    );

    editor.commands.setTextSelection(editor.state.doc.content.size - 1);

    await navigate(editor, "first");
    expect(selectedBlobId(editor)).toBe("blob_a");

    await navigate(editor, "last");
    expect(selectedBlobId(editor)).toBe("blob_c");
  });
});

describe("usePromptWidgetNavigation", () => {
  it("cancels active dictation before navigating", async () => {
    const cancel = vi.fn();
    const dictation = { cancel } as unknown as DictationApi;
    const editor = await mountWithDictation(
      [
        "<p>before</p>",
        '<div data-type="ai-prompt" data-blob-id="blob_a"></div>',
        "<p>after</p>",
      ].join(""),
      dictation,
    );

    await act(async () => {
      editor.commands.focus("end");
      await tick();
    });
    expect(editor.isFocused).toBe(true);

    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowDown",
          code: "ArrowDown",
          altKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      await tick();
    });

    expect(cancel).toHaveBeenCalledOnce();
    expect(selectedBlobId(editor)).toBe("blob_a");
  });
});
