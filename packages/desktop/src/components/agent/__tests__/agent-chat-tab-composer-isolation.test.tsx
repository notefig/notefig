import { describe, it, expect, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";

// react-i18next resolves the hoisted root React copy under vitest (hooks
// break across instances); the tab only uses it for labels, so stub it.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty" as const, init: () => {} },
}));

// Wrap useTaskEntries with a spy: it runs on every Transcript render, so
// its call count IS the transcript's render count — the thing MET-139
// pins down (keystrokes must not reconcile the transcript).
vi.mock("@/entities/agents", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/entities/agents")>();
  return { ...mod, useTaskEntries: vi.fn(mod.useTaskEntries) };
});

import { AgentChatTab } from "@/components/agent/agent-chat-tab";
import {
  agentTasksCollection,
  agentEntriesCollection,
  useTaskEntries,
} from "@/entities/agents";
import { clearComposerDraft } from "@/components/agent/composer-draft-store";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const TASK_ID = "task_isolation";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  for (const task of agentTasksCollection.toArray) {
    agentTasksCollection.delete(task.taskId);
  }
  for (const entry of agentEntriesCollection.toArray) {
    agentEntriesCollection.delete(entry.id);
  }
  clearComposerDraft(TASK_ID);
});

function seedTaskWithEntries(entryCount: number) {
  agentTasksCollection.insert({
    taskId: TASK_ID,
    workspacePath: "/ws",
    title: "isolation probe",
    harnessId: "claude-code",
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
  });
  for (let i = 0; i < entryCount; i++) {
    agentEntriesCollection.insert({
      id: `evt_${String(i).padStart(4, "0")}`,
      taskId: TASK_ID,
      turnId: `turn_${i}`,
      type: i % 2 === 0 ? "user" : "assistant",
      text: `message ${i}`,
      createdAt: i + 1,
    });
  }
}

/** Type into the composer the way a user does: a real editor transaction
 *  per keystroke (the composer is a Tiptap editor — contenteditable ignores
 *  synthetic input events; PromptEditor exposes its instance on the DOM
 *  node for exactly this). */
function typeIntoComposer(element: HTMLElement, char: string) {
  const editor = (
    element as HTMLElement & {
      promptEditor?: { commands: { insertContent: (c: string) => void } };
    }
  ).promptEditor;
  act(() => {
    editor?.commands.insertContent(char);
  });
}

describe("AgentChatTab composer isolation (MET-139)", () => {
  it("keystrokes update the composer without re-rendering the transcript", async () => {
    seedTaskWithEntries(8);

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(createElement(AgentChatTab, { taskId: TASK_ID })));
    // Let live queries and the markdown pipeline settle before baselining.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    const composer = container.querySelector<HTMLElement>(".ProseMirror");
    expect(composer).not.toBeNull();

    const transcriptRenders = vi.mocked(useTaskEntries).mock.calls.length;
    expect(transcriptRenders).toBeGreaterThan(0);

    for (const char of "rapid typing burst") {
      typeIntoComposer(composer!, char);
    }
    await act(async () => {});

    expect(composer!.textContent).toBe("rapid typing burst");
    expect(vi.mocked(useTaskEntries).mock.calls.length).toBe(transcriptRenders);
  });
});
