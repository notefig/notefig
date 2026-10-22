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
/** A widget summoned on the second line of "Hi there", caret in its draft. */
async function composingWidget(): Promise<{ editor: Editor; blobId: string }> {
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
    typeText(ed, "/");
    await tick();
  });
  return { editor: ed, blobId: selectionDraft(ed.state)!.blobId };
}

function typeText(editor: Editor, text: string): boolean {
  const { from, to } = editor.state.selection;
  return Boolean(
    editor.view.someProp("handleTextInput", (handler) =>
      handler(editor.view, from, to, text, () =>
        editor.state.tr.insertText(text, from, to),
      ),
    ),
  );
}

async function runningWidget(): Promise<{ editor: Editor; blobId: string }> {
  const { editor: ed, blobId } = await composingWidget();
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

function widgetPos(editor: Editor): number {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "aiPrompt") found = pos;
    return found < 0;
  });
  return found;
}

function widgetCount(editor: Editor): number {
  let count = 0;
  editor.state.doc.descendants((node) => {
    if (node.type.name === "aiPrompt") count++;
    return true;
  });
  return count;
}

function draftText(editor: Editor): string {
  const node = editor.state.doc.nodeAt(widgetPos(editor));
  return node?.firstChild?.textContent ?? "";
}

/** The widget's node view element — where its decorations land. */
function widgetElement(): HTMLElement | null {
  return document.querySelector(".node-aiPrompt");
}

/** Caret at the start of the line right after the widget. */
function caretBelowWidget(editor: Editor): void {
  const pos = widgetPos(editor);
  const node = editor.state.doc.nodeAt(pos)!;
  editor.commands.setTextSelection(pos + node.nodeSize + 1);
}

async function press(editor: Editor, key: string): Promise<boolean> {
  let handled = false;
  await act(async () => {
    handled = pressKey(editor.view.dom, key);
    await tick();
  });
  return handled;
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
    ["pressed in the editor", (editor: Editor) => editor.view.dom],
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

  it("closes its field: the caret leaves it and nothing types into it", async () => {
    const { editor, blobId } = await runningWidget();
    expect(selectionDraft(editor.state)).toBeNull();
    const draft = document.querySelector(
      `[data-blob-id="${blobId}"] [data-prompt-draft]`,
    );
    expect(draft?.getAttribute("contenteditable")).toBe("false");
    // Even with the caret forced back in, typing is refused.
    editor.commands.setTextSelection(widgetPos(editor) + 2);
    expect(typeText(editor, "x")).toBe(true);
    expect(draftText(editor)).toBe("");
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

describe("deleting and selecting a widget", () => {
  it("Backspace from the line below selects the widget, and a second one deletes a composer", async () => {
    const { editor } = await composingWidget();
    await act(async () => {
      editor.commands.insertContent("draft");
      caretBelowWidget(editor);
      editor.commands.insertContent("below");
      editor.commands.setTextSelection(widgetPos(editor) + editor.state.doc.nodeAt(widgetPos(editor))!.nodeSize + 1);
      await tick();
    });
    await press(editor, "Backspace");
    expect(editor.state.selection.from).toBe(widgetPos(editor));
    expect(widgetElement()?.hasAttribute("data-widget-selected")).toBe(true);
    expect(draftText(editor)).toBe("draft");
    await press(editor, "Backspace");
    expect(widgetCount(editor)).toBe(0);
    expect(editor.state.doc.textContent).toContain("below");
  });

  it("refuses to delete a selected working widget, and says why", async () => {
    const { editor, blobId } = await runningWidget();
    await act(async () => {
      caretBelowWidget(editor);
      await tick();
    });
    await press(editor, "Backspace");
    expect(widgetElement()?.hasAttribute("data-widget-selected")).toBe(true);
    expect(
      widgetElement()?.querySelector(".prompt-widget-lock"),
    ).not.toBeNull();
    for (const key of ["Backspace", "Delete"]) {
      expect(await press(editor, key)).toBe(true);
      expect(widgetCount(editor)).toBe(1);
    }
    expect(prompts.prompts.get(blobId).removalRefusedAt).not.toBeNull();
    expect(document.body.textContent).toContain("promptBlobStopToRemove");
  });

  it("Delete at the end of the line above selects the widget", async () => {
    const { editor } = await runningWidget();
    await act(async () => {
      editor.commands.setTextSelection(9); // end of "Hi there"
      await tick();
    });
    await press(editor, "Delete");
    expect(editor.state.selection.from).toBe(widgetPos(editor));
    expect(widgetElement()?.hasAttribute("data-widget-selected")).toBe(true);
  });

  it("Cmd-A and Delete clear the document around a working widget", async () => {
    const { editor, blobId } = await runningWidget();
    await act(async () => {
      editor.commands.selectAll();
      await tick();
    });
    expect(widgetElement()?.hasAttribute("data-widget-selected")).toBe(true);
    await press(editor, "Delete");
    expect(editor.state.doc.textContent).not.toContain("Hi there");
    expect(widgetCount(editor)).toBe(1);
    expect(editor.state.doc.nodeAt(widgetPos(editor))?.attrs.blobId).toBe(blobId);
  });

  it("a range delete takes a settled widget with it", async () => {
    const { editor } = await runningWidget();
    await act(async () => {
      prompts.setTurn(TURN, TASK, "completed");
      await tick();
    });
    await act(async () => {
      editor.commands.selectAll();
      editor.commands.deleteSelection();
      await tick();
    });
    // The keeper's fresh composer, not the settled widget.
    expect(widgetCount(editor)).toBe(1);
    expect(widgetTaskId(editor)).toBeNull();
  });

  it("typing on a selected composer goes into its field", async () => {
    const { editor } = await composingWidget();
    await act(async () => {
      caretBelowWidget(editor);
      editor.commands.insertContent("below");
      editor.commands.setTextSelection(widgetPos(editor) + editor.state.doc.nodeAt(widgetPos(editor))!.nodeSize + 1);
      await tick();
    });
    await press(editor, "Backspace");
    await act(async () => {
      expect(typeText(editor, "x")).toBe(true);
      await tick();
    });
    expect(widgetCount(editor)).toBe(1);
    expect(draftText(editor)).toBe("x");
    expect(selectionDraft(editor.state)).not.toBeNull();
  });

  it("Cmd-A in a draft selects the draft, then the document", async () => {
    const { editor } = await composingWidget();
    await act(async () => {
      editor.commands.insertContent("draft");
      await tick();
    });
    await act(async () => {
      const event = new KeyboardEvent("keydown", {
        key: "a",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      editor.view.dom.dispatchEvent(event);
      await tick();
    });
    const draft = selectionDraft(editor.state)!;
    expect(editor.state.selection.from).toBe(draft.from);
    expect(editor.state.selection.to).toBe(draft.to);
  });

  it("Cmd-A in an empty draft stays in the draft first", async () => {
    const { editor } = await composingWidget();
    const pressSelectAll = async () =>
      act(async () => {
        editor.view.dom.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "a",
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
        await tick();
      });
    await pressSelectAll();
    expect(selectionDraft(editor.state)).not.toBeNull();
    expect(editor.state.selection.empty).toBe(true);
    await pressSelectAll();
    expect(editor.state.selection.from).toBe(0);
    expect(editor.state.selection.to).toBe(editor.state.doc.content.size);
  });

  /** A running widget moved to the top of the document, under what the
   *  browser hands back for a select-all there: a range from inside its
   *  draft to the end — nothing before it to start on. */
  async function topWidgetUnderSelectAll(
    status: "running" | "completed",
  ): Promise<{ editor: Editor; blobId: string }> {
    const { editor, blobId } = await runningWidget();
    const { TextSelection } = await import("@tiptap/pm/state");
    await act(async () => {
      prompts.setTurn(TURN, TASK, status);
      await tick();
    });
    await act(async () => {
      const pos = widgetPos(editor);
      const node = editor.state.doc.nodeAt(pos)!;
      editor.view.dispatch(
        editor.state.tr.delete(pos, pos + node.nodeSize).insert(0, node),
      );
      await tick();
    });
    expect(widgetPos(editor)).toBe(0);
    await act(async () => {
      const size = editor.state.doc.content.size;
      editor.view.dispatch(
        editor.state.tr.setSelection(
          TextSelection.create(editor.state.doc, 2, size - 1),
        ),
      );
      await tick();
    });
    return { editor, blobId };
  }

  it.each(["Delete", "Backspace"])(
    "a widget opening the document looks selected under a select-all, and %s takes it",
    async (key) => {
      const { editor, blobId } = await topWidgetUnderSelectAll("completed");
      expect(widgetElement()?.hasAttribute("data-widget-selected")).toBe(true);
      await press(editor, key);
      expect(editor.state.doc.textContent).not.toContain("Hi there");
      // The keeper's fresh composer, not the settled widget with its
      // draft cleared.
      expect(widgetCount(editor)).toBe(1);
      expect(editor.state.doc.nodeAt(widgetPos(editor))?.attrs.blobId).not.toBe(
        blobId,
      );
      expect(widgetTaskId(editor)).toBeNull();
    },
  );

  it("a working widget opening the document stays under a select-all delete", async () => {
    const { editor, blobId } = await topWidgetUnderSelectAll("running");
    await press(editor, "Delete");
    expect(editor.state.doc.textContent).not.toContain("Hi there");
    expect(widgetCount(editor)).toBe(1);
    const kept = editor.state.doc.nodeAt(widgetPos(editor))!;
    expect(kept.attrs.blobId).toBe(blobId);
    expect(kept.attrs.taskId).toBe(TASK);
  });

  it("working widgets keep their order when everything around them is deleted", async () => {
    prompts = testPrompts();
    host = fakePromptWidgetHost();
    for (const [blobId, turnId] of [
      ["blob_a", "trn_a"],
      ["blob_b", "trn_b"],
    ]) {
      await prompts.send(blobId, "hi", { taskId: TASK, turnId });
      prompts.setTurn(turnId, TASK, "running");
    }
    const editor = await mount(
      `<p>one</p><div data-type="ai-prompt" data-blob-id="blob_a" data-task-id="${TASK}"></div><p>two</p><div data-type="ai-prompt" data-blob-id="blob_b" data-task-id="${TASK}"></div><p>three</p>`,
    );
    await act(async () => {
      editor.commands.selectAll();
      editor.commands.deleteSelection();
      await tick();
    });
    const order: string[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === "aiPrompt") order.push(node.attrs.blobId);
      return true;
    });
    expect(order).toEqual(["blob_a", "blob_b"]);
    expect(editor.state.doc.textContent).not.toContain("two");
  });

  it("a click on the card never selects it", async () => {
    const { editor } = await composingWidget();
    const pos = widgetPos(editor);
    const node = editor.state.doc.nodeAt(pos)!;
    const event = new MouseEvent("mousedown", { metaKey: true });
    for (const prop of ["handleClickOn", "handleTripleClickOn"] as const) {
      expect(
        editor.view.someProp(prop, (handler) =>
          handler(editor.view, pos + 1, node, pos, event, true),
        ),
      ).toBe(true);
    }
  });

  it("a pasted widget is a fresh one, never a second widget on a session", async () => {
    const { editor } = await runningWidget();
    const node = editor.state.doc.nodeAt(widgetPos(editor))!;
    const { Slice, Fragment } = await import("@tiptap/pm/model");
    const pasted = editor.view.someProp("transformPasted", (transform) =>
      transform(new Slice(Fragment.from(node), 0, 0), editor.view, false),
    )!;
    const copy = pasted.content.firstChild!;
    expect(copy.attrs.taskId).toBeNull();
    expect(copy.attrs.blobId).not.toBe(node.attrs.blobId);
  });

  /** Drop the widget's node through the editor's drop transform, as the
   *  drag grip does: `view.dragging` holds it, the drop event goes first. */
  async function dropWidget(
    editor: Editor,
    { copy }: { copy: boolean },
  ): Promise<void> {
    const { Slice, Fragment } = await import("@tiptap/pm/model");
    const { NodeSelection } = await import("@tiptap/pm/state");
    const pos = widgetPos(editor);
    const node = editor.state.doc.nodeAt(pos)!;
    const slice = new Slice(Fragment.from(node), 0, 0);
    const { view } = editor;
    view.dragging = {
      slice,
      move: true,
      node: NodeSelection.create(editor.state.doc, pos),
    } as typeof view.dragging;
    const drop = new Event("drop") as DragEvent;
    Object.assign(drop, { altKey: copy, ctrlKey: copy });
    view.someProp("handleDOMEvents", (handlers) => {
      handlers.drop?.(view, drop);
    });
    const dropped = view.someProp("transformPasted", (transform) =>
      transform(slice, view, false),
    )!;
    view.dragging = null;
    await act(async () => {
      const tr = editor.state.tr;
      if (!copy) tr.delete(pos, pos + node.nodeSize);
      // Above "Hi there".
      tr.insert(0, dropped.content);
      view.dispatch(tr);
      await tick();
    });
  }

  it("a widget dragged elsewhere keeps its round and its answer", async () => {
    const { editor, blobId } = await runningWidget();
    await act(async () => {
      prompts.setTurn(TURN, TASK, "completed");
      await tick();
    });
    await dropWidget(editor, { copy: false });
    expect(widgetCount(editor)).toBe(1);
    expect(widgetPos(editor)).toBe(0);
    const moved = editor.state.doc.nodeAt(0)!;
    expect(moved.attrs.blobId).toBe(blobId);
    expect(moved.attrs.taskId).toBe(TASK);
    expect(prompts.prompts.get(blobId).state).toEqual({
      name: "settled",
      outcome: "done",
    });
    expect(
      widgetElement()?.querySelector('[data-blob-phase="done"]'),
    ).not.toBeNull();
  });

  it("a widget drag-copied is a fresh one", async () => {
    const { editor, blobId } = await runningWidget();
    await act(async () => {
      prompts.setTurn(TURN, TASK, "completed");
      await tick();
    });
    await dropWidget(editor, { copy: true });
    expect(widgetCount(editor)).toBe(2);
    const copy = editor.state.doc.nodeAt(0)!;
    expect(copy.attrs.blobId).not.toBe(blobId);
    expect(copy.attrs.taskId).toBeNull();
  });
});
