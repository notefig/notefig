import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CoreProvider } from "@notefig/core/react";
import type { AgentTaskRow } from "@/modules/agents/agent-collections";

// The row's menu reads its harness's actions; what they are is
// useSessionActions' own business (and its own tests').
vi.mock("@/modules/agents/react", () => ({
  describeTaskMeta: () => null,
  useAgentTaskList: () => [],
  useSessionActions: () => ({
    sessionId: null,
    canRefresh: false,
    resume: { supported: false, command: null },
  }),
}));

import { SessionRow } from "@/components/agent/sessions-panel";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  document.body.innerHTML = "";
});

const task = {
  taskId: "t1",
  title: "Fix the build",
  status: "idle",
  workspacePath: "/ws",
  harnessId: "claude",
} as AgentTaskRow;

function renderRow() {
  const onOpen = vi.fn();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      createElement(CoreProvider, {
        core: { agents: { task: () => ({}) } } as never,
        children: createElement(SessionRow, {
          task,
          meta: "now",
          isRunning: false,
          active: false,
          onOpen,
        }),
      }),
    ),
  );
  const row = container.querySelector('[data-session-row="t1"]')!;
  return { onOpen, row };
}

function dispatch(target: Element, type: string, init: MouseEventInit = {}) {
  act(() => {
    target.dispatchEvent(
      new MouseEvent(type, { bubbles: true, cancelable: true, ...init }),
    );
  });
}

describe("a session row opens like a file in the tree", () => {
  it("replaces the tab in front on click, opens a new tab on Mod+click", () => {
    const { onOpen, row } = renderRow();
    dispatch(row, "click");
    expect(onOpen).toHaveBeenLastCalledWith("replace");
    dispatch(row, "click", { metaKey: true });
    expect(onOpen).toHaveBeenLastCalledWith("new-tab");
    dispatch(row, "click", { ctrlKey: true });
    expect(onOpen).toHaveBeenLastCalledWith("new-tab");
  });

  it("leads its right-click menu with Open in New Tab", () => {
    const { onOpen, row } = renderRow();
    dispatch(row, "contextmenu");
    const items = [...document.querySelectorAll('[role="menuitem"]')];
    expect(items[0]?.textContent).toBe("Open in new tab");
    dispatch(items[0]!, "click");
    expect(onOpen).toHaveBeenCalledWith("new-tab");
  });
});
