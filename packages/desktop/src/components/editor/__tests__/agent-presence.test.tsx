import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import { useAgentEditingPaths } from "@/components/editor/agent-presence";
import { agentEntriesCollection } from "@/agent/agent-collections";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function Probe() {
  const paths = useAgentEditingPaths();
  return createElement("div", { "data-testid": "paths" }, [...paths].join(","));
}

function readProbe(): string {
  return container!.querySelector('[data-testid="paths"]')!.textContent ?? "";
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  for (const entry of agentEntriesCollection.toArray) {
    agentEntriesCollection.delete(entry.id);
  }
});

describe("useAgentEditingPaths", () => {
  it("shows a file's path while its tool call is pending, and drops it on completion", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(createElement(Probe)));

    expect(readProbe()).toBe("");

    act(() => {
      agentEntriesCollection.insert({
        id: "evt_1",
        taskId: "task_1",
        turnId: "turn_1",
        type: "tool_call",
        toolCallId: "tc_1",
        toolCall: {
          toolCallId: "tc_1",
          title: "author_blob",
          status: "pending",
          locations: [{ path: "/ws/notes.md" }],
        },
        createdAt: Date.now(),
      });
    });
    await act(async () => {});
    expect(readProbe()).toBe("/ws/notes.md");

    act(() => {
      agentEntriesCollection.update("evt_1", (draft) => {
        if (draft.toolCall) draft.toolCall.status = "completed";
      });
    });
    await act(async () => {});
    expect(readProbe()).toBe("");
  });
});
