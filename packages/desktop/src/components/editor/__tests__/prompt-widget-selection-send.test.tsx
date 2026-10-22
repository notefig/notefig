/**
 * Repro (doc references): sending from a selection-summoned widget must
 * bind THAT widget's state — reported broken: the prompt queued but the
 * widget stayed composing, Open Chat was dead, and the widget sometimes
 * duplicated. Mounts the real node view + PromptBlob like
 * prompt-widget-backspace.test.tsx, then runs the marker round-trip the
 * file-sync adoption path performs after send.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty" as const, init: () => {} },
}));

import { Editor, EditorContent, useEditor } from "@tiptap/react";
import type { JSONContent } from "@tiptap/core";
import { editorExtensions } from "@/components/editor/tiptap-editor-kit";
import { widgetRendererNodes, selectionDraft } from "@notefig/widgets";
import {
  fakePromptWidgetHost,
  testPrompts,
  withHost,
  type TestPrompts,
} from "@notefig/widgets/testing";
import type { PromptWidgetHost } from "@notefig/widgets";
import { createMarkdownCodec } from "@/components/editor/markdown-codec";
import { getEditorMarkdown } from "@/components/editor/use-editor-file-sync";
import { adoptExternalContent } from "@/components/editor/adopt-external-content";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let prompts: TestPrompts = testPrompts();

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

/** A host whose dispatch writes the queued turn row, as the real host's
 *  collections do. */
function liveRoundHost(): PromptWidgetHost {
  prompts = testPrompts();
  return fakePromptWidgetHost({
    dispatchPrompt: vi.fn(({ taskId }) => {
      prompts.setTurn("trn_fake", taskId, "queued");
      return { turnId: "trn_fake" };
    }),
  });
}

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
        prompts: prompts.prompts,
      }),
    ],
    content,
  });
  useEffect(() => {
    if (editor) onEditor(editor);
  }, [editor, onEditor]);
  return editor ? createElement(EditorContent, { editor }) : null;
}

async function mountedEditor(
  content: string,
  host: PromptWidgetHost,
): Promise<Editor> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  let editor: Editor | null = null;
  await act(async () => {
    root!.render(
      withHost(
        host,
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

function pressKey(editor: Editor, key: string): { handled: boolean } {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
  });
  editor.view.dom.dispatchEvent(event);
  return { handled: event.defaultPrevented };
}

type FoundWidget = { blobId: string | null; taskId: string | null };
function findWidgets(editor: Editor): FoundWidget[] {
  const found: FoundWidget[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === "aiPrompt") {
      found.push({
        blobId: (node.attrs.blobId as string | null) ?? null,
        taskId: (node.attrs.taskId as string | null) ?? null,
      });
    }
  });
  return found;
}

async function summonOverSelection(editor: Editor): Promise<string> {
  await act(async () => {
    editor.commands.setTextSelection({ from: 4, to: 9 }); // "there"
    typeText(editor, "/");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const widgets = findWidgets(editor);
  expect(widgets).toHaveLength(1);
  expect(selectionDraft(editor.state)?.blobId).toBe(widgets[0].blobId);
  return widgets[0].blobId!;
}

async function typeAndSend(editor: Editor): Promise<void> {
  await act(async () => {
    editor.commands.insertContent("make it shorter");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    pressKey(editor, "Enter");
    // send() awaits resolvePromptTarget → give the microtasks room.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("selection-summoned widget send", () => {
  it("binds the summoned widget's state and keeps exactly one widget", async () => {
    const host = liveRoundHost();
    const editor = await mountedEditor(
      "<p>Hi there</p><p>More prose</p>",
      host,
    );
    const blobId = await summonOverSelection(editor);
    await typeAndSend(editor);

    expect(host.dispatchPrompt).toHaveBeenCalledTimes(1);
    const args = vi.mocked(host.dispatchPrompt).mock.calls[0][0];
    expect(args.taskId).toBe("task_shared");
    expect(args.text).toBe("make it shorter");
    expect(args.target.reference).toEqual({ text: "there", from: 4, to: 9 });

    expect(prompts.prompts.get(blobId)).toMatchObject({
      boundTurnId: "trn_fake",
      boundTaskId: "task_shared",
      lastSentPrompt: "make it shorter",
    });
    expect(findWidgets(editor)).toEqual([{ blobId, taskId: "task_shared" }]);
  });

  it("removing the quote turns it into a regular widget before send", async () => {
    const host = liveRoundHost();
    const editor = await mountedEditor(
      "<p>Hi there</p><p>More prose</p>",
      host,
    );
    const blobId = await summonOverSelection(editor);

    // The chip's ✕ (revealed on hover; jsdom clicks it regardless).
    const remove = document.querySelector(
      'button[aria-label="promptBlobReferenceRemove"]',
    ) as HTMLButtonElement;
    expect(remove).toBeTruthy();
    await act(async () => {
      remove.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Reference and summon-arming both dropped from the node.
    const node = editor.state.doc.nodeAt(
      (() => {
        let pos = -1;
        editor.state.doc.descendants((n, p) => {
          if (n.type.name === "aiPrompt") pos = p;
          return pos < 0;
        });
        return pos;
      })(),
    );
    expect(node?.attrs.reference).toBeNull();
    expect(node?.attrs.summoned).toBe(false);

    await typeAndSend(editor);
    const args = vi.mocked(host.dispatchPrompt).mock.calls[0][0];
    expect(args.target.reference).toBeUndefined();
    expect(prompts.prompts.get(blobId).boundTurnId).toBe("trn_fake");
  });

  it("survives the own-save marker round-trip without duplicating", async () => {
    const host = liveRoundHost();
    const editor = await mountedEditor(
      "<p>Hi there</p><p>More prose</p>",
      host,
    );
    const blobId = await summonOverSelection(editor);
    await typeAndSend(editor);

    // What autosave would write: the marker between the two paragraphs.
    const markdown = getEditorMarkdown(editor);
    expect(markdown).toContain("notefig:prompt");

    // The adoption path re-parses that same content back into the editor.
    const codec = createMarkdownCodec();
    const incoming = codec.parse(markdown) as JSONContent;
    await act(async () => {
      adoptExternalContent(editor, incoming);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(findWidgets(editor)).toEqual([{ blobId, taskId: "task_shared" }]);
    expect(prompts.prompts.get(blobId)).toMatchObject({
      boundTurnId: "trn_fake",
      boundTaskId: "task_shared",
    });
  });

  it("survives an agent rewrite that drops the marker (re-assertion)", async () => {
    const host = liveRoundHost();
    const editor = await mountedEditor(
      "<p>Hi there</p><p>More prose</p>",
      host,
    );
    const blobId = await summonOverSelection(editor);
    await typeAndSend(editor);

    // Harnesses rewrite whole files and typically omit our marker.
    const codec = createMarkdownCodec();
    const incoming = codec.parse(
      "Hi there, rewritten\n\nMore prose, expanded",
    ) as JSONContent;
    await act(async () => {
      adoptExternalContent(editor, incoming);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(findWidgets(editor)).toEqual([{ blobId, taskId: "task_shared" }]);
    expect(prompts.prompts.get(blobId)).toMatchObject({
      boundTurnId: "trn_fake",
      boundTaskId: "task_shared",
    });
  });
});
