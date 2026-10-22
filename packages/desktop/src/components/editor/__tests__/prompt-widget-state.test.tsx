/**
 * The mounted widget acting on its state (MET-248): what the keys and the
 * buttons do comes from the prompt service's state, not from the face's own
 * reading of the round. Mounts the real node view and PromptBlob like
 * prompt-widget-backspace.test.tsx, over a prompt service a test drives.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { StrictMode, act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty" as const, init: () => {} },
}));

import { Editor, EditorContent, useEditor } from "@tiptap/react";
import { editorExtensions } from "@/components/editor/tiptap-editor-kit";
import { widgetRendererNodes, selectionDraft } from "@notefig/widgets";
import type { PromptWidgetHost } from "@notefig/widgets";
import {
  fakePromptWidgetHost,
  testPrompts,
  withHost,
  type TestPrompts,
} from "@notefig/widgets/testing";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const TASK = "task_shared";
const TURN = "trn_fake";

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let prompts: TestPrompts;
let host: PromptWidgetHost;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function Harness({
  content = "<p>Hi there</p><p></p>",
  onEditor,
}: {
  content?: string;
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

/** Mount a document over the current `prompts` and `host`. */
async function mount(content?: string): Promise<Editor> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  let editor: Editor | null = null;
  await act(async () => {
    // StrictMode like the app's root: mount effects run twice.
    root!.render(
      createElement(
        StrictMode,
        null,
        withHost(
          host,
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

/** A document with a widget summoned on its second line, prompt sent and
 *  its turn running. Returns the editor and the widget's id. */
async function runningWidget(): Promise<{ editor: Editor; blobId: string }> {
  prompts = testPrompts();
  host = fakePromptWidgetHost({
    dispatchPrompt: vi.fn(({ taskId }) => {
      prompts.setTurn(TURN, taskId, "queued");
      return { turnId: TURN };
    }),
  });
  const ed = await mount();
  await act(async () => {
    ed.commands.setTextSelection(11);
    const { from, to } = ed.state.selection;
    ed.view.someProp("handleTextInput", (handler) =>
      handler(ed.view, from, to, "/", () => ed.state.tr.insertText("/", from, to)),
    );
    await tick();
  });
  const blobId = selectionDraft(ed.state)!.blobId;
  await act(async () => {
    ed.commands.insertContent("make it shorter");
    await tick();
  });
  await act(async () => {
    pressKey(ed.view.dom, "Enter");
    await tick();
    await tick();
  });
  await act(async () => {
    prompts.setTurn(TURN, TASK, "running");
    await tick();
  });
  expect(prompts.prompts.get(blobId).state).toEqual({
    name: "working",
    turn: "running",
  });
  return { editor: ed, blobId };
}

function pressKey(target: EventTarget, key: string): boolean {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

function widgetTaskId(editor: Editor): string | null | undefined {
  let taskId: string | null | undefined;
  editor.state.doc.descendants((node) => {
    if (node.type.name === "aiPrompt") taskId = node.attrs.taskId ?? null;
    return taskId === undefined;
  });
  return taskId;
}

describe("a running widget", () => {
  it.each([
    ["with the caret in its draft", (editor: Editor) => editor.view.dom],
    ["with the caret elsewhere", () => document.body],
  ])("stops on Escape %s, staying on its session", async (_, target) => {
    const { editor, blobId } = await runningWidget();
    await act(async () => {
      pressKey(target(editor), "Escape");
      await tick();
    });
    expect(host.cancelTask).toHaveBeenCalledWith(TASK);
    expect(prompts.prompts.get(blobId).boundTaskId).toBe(TASK);
    expect(widgetTaskId(editor)).toBe(TASK);
  });

  it("Backspace in its emptied draft doesn't dismiss it", async () => {
    const { editor, blobId } = await runningWidget();
    expect(selectionDraft(editor.state)?.blobId).toBe(blobId);
    await act(async () => {
      pressKey(editor.view.dom, "Backspace");
      await tick();
    });
    expect(widgetTaskId(editor)).toBe(TASK);
  });

  it("writes its session into the file marker, and Edit takes it out", async () => {
    const { editor, blobId } = await runningWidget();
    expect(widgetTaskId(editor)).toBe(TASK);
    const edit = document.querySelector(
      'button[aria-label="promptBlobEdit"]',
    ) as HTMLButtonElement | null;
    expect(edit).toBeTruthy();
    await act(async () => {
      edit!.click();
      await tick();
    });
    expect(prompts.prompts.get(blobId).boundTaskId).toBeNull();
    expect(widgetTaskId(editor)).toBeNull();
  });
});

describe("the file marker", () => {
  const WIDGET = (taskId?: string) =>
    `<p>Hi</p><div data-type="ai-prompt" data-blob-id="blob_m"${
      taskId ? ` data-task-id="${taskId}"` : ""
    }></div><p></p>`;

  it("takes a session bound while the widget wasn't mounted", async () => {
    // A send that finished while its tab was hidden: no node view was
    // there to write the marker.
    prompts = testPrompts();
    host = fakePromptWidgetHost();
    await prompts.send("blob_m", "hi", { taskId: TASK, turnId: TURN });
    const editor = await mount(WIDGET());
    expect(widgetTaskId(editor)).toBe(TASK);
  });

  it("keeps a persisted session the service hasn't adopted yet", async () => {
    prompts = testPrompts();
    // Reachability still pending: the service is unbound for now.
    host = fakePromptWidgetHost({ isTaskReachable: () => new Promise(() => {}) });
    const editor = await mount(WIDGET("task_saved"));
    expect(prompts.prompts.get("blob_m").boundTaskId).toBeNull();
    expect(widgetTaskId(editor)).toBe("task_saved");
  });
});
