/**
 * Escape on a running inline prompt widget stops the turn without
 * forgetting it — the widget must stay bound to its original session so
 * a later prompt resumes the same agent (MET-248).
 */
import { describe, it, expect, afterEach, vi, type Mock } from "vitest";
import { act, createElement, useEffect, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty" as const, init: () => {} },
}));

import { Editor, EditorContent, useEditor } from "@tiptap/react";
import { editorExtensions } from "@/components/editor/tiptap-editor-kit";
import { widgetRendererNodes, selectionDraft } from "@notefig/widgets";
import { fakePromptWidgetHost, withHost } from "@notefig/widgets/testing";
import type { PromptWidgetHost, PromptRound } from "@notefig/widgets";
import type { AgentTurn, AgentTaskRow } from "@notefig/shared/agent";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

const EMPTY_ROUND: PromptRound = {
  turn: undefined,
  task: undefined,
  entries: [],
  taskTurns: [],
  pendingPermissions: [],
};

const TASK_ID = "task_escape_test";
const TURN_ID = "trn_escape_test";

const RUNNING_ROUND = {
  turn: {
    turnId: TURN_ID,
    taskId: TASK_ID,
    sessionId: "sess_escape_test",
    status: "running",
    startedAt: Date.now(),
  } as AgentTurn,
  task: {
    taskId: TASK_ID,
    workspacePath: "/ws",
    title: "escape test",
    status: "running",
    harnessId: "claude",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as AgentTaskRow,
  entries: [],
  taskTurns: [],
  pendingPermissions: [],
} satisfies PromptRound;

const CANCELLED_ROUND = {
  ...RUNNING_ROUND,
  turn: { ...RUNNING_ROUND.turn, status: "cancelled" as const },
  task: { ...RUNNING_ROUND.task, status: "cancelled" as const },
} satisfies PromptRound;

/** Minimal external store so the test can drive round transitions from
 *  outside React, matching how the real host's collections update the
 *  widget. */
function createRoundStore() {
  let round = EMPTY_ROUND;
  const listeners = new Set<() => void>();
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => round,
    publish: (next: PromptRound) => {
      round = next;
      for (const listener of listeners) listener();
    },
  };
}

function runningRoundHost(): {
  host: PromptWidgetHost;
  cancelTask: ReturnType<typeof vi.fn>;
  cancelTurnAndForget: ReturnType<typeof vi.fn>;
  publishRound: (round: PromptRound) => void;
} {
  const cancelTask = vi.fn();
  const cancelTurnAndForget = vi.fn(async () => true);
  const store = createRoundStore();

  const host = fakePromptWidgetHost({
    startOrGetSharedSession: vi.fn(async () => TASK_ID),
    useRound: vi.fn(() =>
      useSyncExternalStore(store.subscribe, store.getSnapshot),
    ),
    getTurnStatus: vi.fn(() => store.getSnapshot().turn?.status),
    dispatchPrompt: vi.fn(() => {
      store.publish(RUNNING_ROUND);
      return { turnId: TURN_ID };
    }),
    cancelTask,
    cancelTurnAndForget,
  });
  return { host, cancelTask, cancelTurnAndForget, publishRound: store.publish };
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
      ...widgetRendererNodes({ filePath: "/ws/doc.md", basePath: "/ws" }),
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

function pressKey(editor: Editor, key: string): void {
  editor.view.dom.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
    }),
  );
}

function countPromptWidgets(editor: Editor): number {
  let count = 0;
  editor.state.doc.descendants((node) => {
    if (node.type.name === "aiPrompt") {
      count += 1;
      return false;
    }
    return true;
  });
  return count;
}

function selectPromptWidget(editor: Editor): boolean {
  let pos: number | null = null;
  editor.state.doc.descendants((node, p) => {
    if (node.type.name === "aiPrompt") {
      pos = p;
      return false;
    }
    return true;
  });
  if (pos === null) return false;
  return editor.commands.setNodeSelection(pos) && editor.commands.focus();
}

function widgetPhase(): string | null {
  const widget = container!.querySelector('[data-type="ai-prompt"]');
  return widget?.querySelector('[data-blob-phase]')?.getAttribute("data-blob-phase") ?? null;
}

function widgetTaskId(editor: Editor): string | null {
  let taskId: string | null = null;
  editor.state.doc.descendants((node) => {
    if (node.type.name === "aiPrompt") {
      taskId = node.attrs.taskId ?? null;
      return false;
    }
    return true;
  });
  return taskId;
}

async function summonWidget(editor: Editor): Promise<void> {
  await act(async () => {
    editor.commands.setTextSelection(11);
    typeText(editor, "/");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(selectionDraft(editor.state)).toBeTruthy();
}

async function setupRunningWidget(editor: Editor): Promise<void> {
  await summonWidget(editor);
  await act(async () => {
    editor.commands.insertContent("hello agent");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    pressKey(editor, "Enter");
    // send() awaits resolvePromptTarget → give the microtasks room.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function pressEscape(editor: Editor): Promise<void> {
  await act(async () => {
    pressKey(editor, "Escape");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function pressDeleteOnSelectedWidget(editor: Editor): Promise<void> {
  await act(async () => {
    selectPromptWidget(editor);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    pressKey(editor, "Delete");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function stopAndAssertStillBound(
  editor: Editor,
  cancelTask: Mock,
  cancelTurnAndForget: Mock,
): Promise<void> {
  await pressEscape(editor);
  expect(cancelTask).toHaveBeenCalledTimes(1);
  expect(cancelTask).toHaveBeenCalledWith(TASK_ID);
  expect(cancelTurnAndForget).not.toHaveBeenCalled();
}

async function publishCancelled(
  editor: Editor,
  publishRound: (round: PromptRound) => void,
): Promise<void> {
  await act(async () => {
    publishRound(CANCELLED_ROUND);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(widgetPhase()).toBe("done");
  expect(widgetTaskId(editor)).toBe(TASK_ID);
}

async function sendFollowUpAndAssertSameTask(editor: Editor, host: PromptWidgetHost): Promise<void> {
  await act(async () => {
    editor.commands.insertContent("follow up");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    pressKey(editor, "Enter");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(host.dispatchPrompt).toHaveBeenCalledTimes(2);
  const followUpCall = vi.mocked(host.dispatchPrompt).mock.calls[1];
  expect(followUpCall[0].taskId).toBe(TASK_ID);
}

describe("escape on a running prompt widget", () => {
  it("stops the agent but keeps the widget bound to its session", async () => {
    const { host, cancelTask, cancelTurnAndForget, publishRound } =
      runningRoundHost();
    const editor = await mountedEditor("<p>Hi there</p><p></p>", host);
    await setupRunningWidget(editor);
    await stopAndAssertStillBound(editor, cancelTask, cancelTurnAndForget);
    await publishCancelled(editor, publishRound);
    await sendFollowUpAndAssertSameTask(editor, host);
  });

  it("blocks ProseMirror deletion while the task is running", async () => {
    const { host, publishRound } = runningRoundHost();
    const editor = await mountedEditor("<p>Hi there</p><p></p>", host);
    await setupRunningWidget(editor);
    await pressDeleteOnSelectedWidget(editor);
    expect(countPromptWidgets(editor)).toBe(1);
    expect(widgetPhase()).toBe("running");

    await publishCancelled(editor, publishRound);
    await pressDeleteOnSelectedWidget(editor);
    expect(countPromptWidgets(editor)).toBe(0);
  });

  it("keeps deletion protection when two markers share a blobId", async () => {
    const { host, publishRound } = runningRoundHost();
    const editor = await mountedEditor(
      `<div data-type="ai-prompt" data-blob-id="shared" data-task-id="${TASK_ID}"><div data-type="prompt-draft"></div></div>` +
        `<p>between</p>` +
        `<div data-type="ai-prompt" data-blob-id="shared" data-task-id="${TASK_ID}"><div data-type="prompt-draft"></div></div>`,
      host,
    );
    await act(async () => {
      publishRound(RUNNING_ROUND);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(countPromptWidgets(editor)).toBe(2);

    await pressDeleteOnSelectedWidget(editor);
    expect(countPromptWidgets(editor)).toBe(1);

    // Deleting the last copy must still be blocked because the task is
    // still running.
    await pressDeleteOnSelectedWidget(editor);
    expect(countPromptWidgets(editor)).toBe(1);
  });

  it("preserves a running widget through a full-document replacement", async () => {
    const { host, publishRound } = runningRoundHost();
    const editor = await mountedEditor(
      `<p>original</p><div data-type="ai-prompt" data-blob-id="shared" data-task-id="${TASK_ID}"><div data-type="prompt-draft"></div></div>`,
      host,
    );
    await act(async () => {
      publishRound(RUNNING_ROUND);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(countPromptWidgets(editor)).toBe(1);
    expect(widgetPhase()).toBe("running");

    await act(async () => {
      editor.commands.setContent("<p>replacement text</p>");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(editor.state.doc.textContent).toContain("replacement text");
    expect(countPromptWidgets(editor)).toBe(1);
    expect(widgetPhase()).toBe("running");
  });
});
