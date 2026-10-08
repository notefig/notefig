import { describe, it, expect, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";

// react-i18next resolves the hoisted root React copy under vitest (hooks
// break across instances); the cards only use it for labels, so stub it.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty" as const, init: () => {} },
}));

import {
  fakePromptWidgetHost,
  withHost,
} from "@notefig/widgets/testing";
import type { AgentEntry, ToolCallUpdate } from "@notefig/shared/agent";
import { EntryView } from "@/components/agent/agent-chat-tab";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function renderToolCall(toolCall: Partial<ToolCallUpdate>) {
  const entry: AgentEntry = {
    id: "e1",
    taskId: "task_1",
    turnId: "turn_1",
    type: "tool_call",
    toolCallId: "call_1",
    toolCall: { toolCallId: "call_1", title: "widget_respond", ...toolCall },
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(withHost(fakePromptWidgetHost(), createElement(EntryView, { entry }))),
  );
}

function card(): HTMLElement | null {
  return container!.querySelector('[data-tool-call][data-tool-title="widget_respond"]');
}

function markdown(): HTMLElement | null {
  return container!.querySelector('[data-testid="markdown"]');
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

describe("widget_respond in the transcript", () => {
  it("lands collapsed to its summary line; the heading expands the answer", () => {
    renderToolCall({
      status: "completed",
      rawInput: { kind: "answer", markdown: "Two **short** paragraphs", title: "Summary" },
    });
    expect(card()?.getAttribute("data-tool-status")).toBe("completed");
    expect(card()?.querySelector("[data-widget-response]")?.getAttribute("data-widget-response")).toBe("answer");
    expect(markdown()).toBeNull();
    expect(card()?.textContent).toContain("Summary");
    act(() => card()!.querySelector("button")!.click());
    expect(markdown()?.textContent).toBe("Two **short** paragraphs");
  });

  it("an issue carries the widget's warning card", () => {
    renderToolCall({
      status: "completed",
      rawInput: { kind: "issue", markdown: "can't tell which paragraph" },
    });
    expect(card()?.querySelector(".border-warning\\/40")).not.toBeNull();
    act(() => card()!.querySelector("button")!.click());
    expect(markdown()?.className).toContain("text-warning");
  });

  it("an input that doesn't parse yet stays a plain tool line", () => {
    renderToolCall({ status: "in_progress", rawInput: { kind: "answer" } });
    expect(markdown()).toBeNull();
    expect(card()?.querySelector("[data-widget-response]") ?? null).toBeNull();
  });

  it("a pending call with its full answer keeps the in-flight tool line", () => {
    renderToolCall({
      status: "pending",
      rawInput: { kind: "answer", markdown: "not delivered yet" },
    });
    expect(card()?.getAttribute("data-tool-status")).toBe("pending");
    expect(card()?.querySelector("[data-widget-response]") ?? null).toBeNull();
  });

  it("a failed call stays a plain tool line", () => {
    renderToolCall({
      status: "failed",
      rawInput: { kind: "answer", markdown: "never delivered" },
    });
    expect(markdown()).toBeNull();
  });
});
