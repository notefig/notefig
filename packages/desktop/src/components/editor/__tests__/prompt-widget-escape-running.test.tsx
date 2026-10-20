/**
 * Escape on a running inline prompt widget stops the turn without
 * forgetting it — the widget must stay bound to its original session so
 * a later prompt resumes the same agent (MET-248).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
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

const RUNNING_ROUND: PromptRound = {
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
};

const CANCELLED_ROUND: PromptRound = {
  ...RUNNING_ROUND,
  turn: { ...RUNNING_ROUND.turn, status: "cancelled" as const },
  task: { ...RUNNING_ROUND.task, status: "cancelled" as const },
};

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

describe("escape on a running prompt widget", () => {
  it("stops the agent but keeps the widget bound to its session", async () => {
    const { host, cancelTask, cancelTurnAndForget, publishRound } =
      runningRoundHost();
    const editor = await mountedEditor("<p>Hi there</p><p></p>", host);
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

    expect(widgetPhase()).toBe("running");
    expect(widgetTaskId(editor)).toBe(TASK_ID);

    // Escape stops the turn. The widget must not be removed and its task
    // binding must survive so a follow-up targets the same session.
    await act(async () => {
      pressKey(editor, "Escape");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(cancelTask).toHaveBeenCalledTimes(1);
    expect(cancelTask).toHaveBeenCalledWith(TASK_ID);
    expect(cancelTurnAndForget).not.toHaveBeenCalled();

    // Publish the cancelled turn the real facade would surface.
    await act(async () => {
      publishRound(CANCELLED_ROUND);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(widgetPhase()).toBe("done");
    expect(widgetTaskId(editor)).toBe(TASK_ID);

    // A follow-up from the stopped widget must resume the original task.
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
  });
});
