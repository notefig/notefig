/**
 * Escape on a running inline prompt widget stops the turn without
 * forgetting it — the widget must stay bound to its original session so
 * a later prompt resumes the same agent (MET-248).
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
import {
  widgetRendererNodes,
  selectionDraft,
} from "@notefig/widgets";
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

function runningRoundHost(): {
  host: PromptWidgetHost;
  cancelTask: ReturnType<typeof vi.fn>;
  cancelTurnAndForget: ReturnType<typeof vi.fn>;
} {
  let round = EMPTY_ROUND;
  const cancelTask = vi.fn();
  const cancelTurnAndForget = vi.fn(async () => true);
  const host = fakePromptWidgetHost({
    startOrGetSharedSession: vi.fn(async () => TASK_ID),
    useRound: vi.fn(() => round),
    getTurnStatus: vi.fn(() => round.turn?.status),
    dispatchPrompt: vi.fn(() => {
      round = {
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
      return { turnId: TURN_ID };
    }),
    cancelTask,
    cancelTurnAndForget,
  });
  return { host, cancelTask, cancelTurnAndForget };
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

function pressKey(editor: Editor, key: string): { handled: boolean } {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
  });
  editor.view.dom.dispatchEvent(event);
  return { handled: event.defaultPrevented };
}

function hasWidget(editor: Editor): boolean {
  let found = false;
  editor.state.doc.descendants((node) => {
    if (node.type.name === "aiPrompt") found = true;
    return !found;
  });
  return found;
}

async function summonWidget(editor: Editor): Promise<void> {
  await act(async () => {
    editor.commands.setTextSelection(11);
    typeText(editor, "/");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(hasWidget(editor)).toBe(true);
  expect(selectionDraft(editor.state)).toBeTruthy();
}

describe("escape on a running prompt widget", () => {
  it("stops the agent but keeps the widget bound to its session", async () => {
    const { host, cancelTask, cancelTurnAndForget } = runningRoundHost();
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

    const widget = container!.querySelector('[data-type="ai-prompt"]');
    expect(widget).not.toBeNull();
    expect(widget?.querySelector('[data-blob-phase]')?.getAttribute("data-blob-phase")).toBe("running");

    // Keep the caret in the draft (the same path the global hotkey defers
    // to) and press Escape: a running turn must be stopped, not removed.
    expect(selectionDraft(editor.state)).toBeTruthy();

    await act(async () => {
      pressKey(editor, "Escape");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(cancelTask).toHaveBeenCalledTimes(1);
    expect(cancelTask).toHaveBeenCalledWith(TASK_ID);
    expect(cancelTurnAndForget).not.toHaveBeenCalled();
  });
});
