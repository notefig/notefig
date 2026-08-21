import { describe, it, expect, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";

// react-i18next resolves the hoisted root React copy under vitest (hooks
// break across instances); the widget only uses it for labels, so stub it.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  // utils/intl registers this plugin at module load via an import chain
  // from prompt-blob; a no-op 3rdParty module satisfies i18next.use().
  initReactI18next: { type: "3rdParty" as const, init: () => {} },
}));

import { DoneState } from "@/components/agent/prompt-blob";
import type { WidgetResponse } from "@/agent/tools/widget-respond";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const noop = () => {};

function render(props: {
  response?: WidgetResponse | null;
  fallbackText?: string | null;
  cancelled?: boolean;
}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      createElement(DoneState, {
        cancelled: props.cancelled ?? false,
        response: props.response ?? null,
        fallbackText: props.fallbackText ?? null,
        touchedFiles: [],
        onOpenFile: noop,
        onOpenChat: noop,
        onDismiss: noop,
        replyDraft: "",
        setReplyDraft: noop,
        onReply: noop,
        onReplyEscape: noop,
        replyDisabled: false,
        workspacePath: "/test-workspace",
      }),
    ),
  );
}

/** Markdown renders through the conversion worker (inline fallback in this
 *  environment) — poll until the prose container has content. */
async function settleMarkdown() {
  for (let i = 0; i < 200; i++) {
    const prose = container!.querySelector(".prose");
    if (prose && prose.innerHTML !== "") return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error("Markdown never rendered");
}

function clickSummary() {
  // The summary line is the first button in the header row.
  const button = container!.querySelector("button")!;
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

describe("DoneState", () => {
  it("renders the full response body by default, no click needed (MET-133)", async () => {
    render({
      response: { kind: "answer", markdown: "**bold** body", title: "Title" },
    });
    await settleMarkdown();
    expect(container!.querySelector("strong")?.textContent).toBe("bold");
    // Expanded, the summary line shows the heading, not the body echo.
    expect(container!.querySelector("button")?.textContent).toBe("Title");
  });

  it("collapses to the one-line summary on click, and re-expands", async () => {
    render({ response: { kind: "answer", markdown: "the whole answer" } });
    await settleMarkdown();
    expect(container!.textContent).toContain("the whole answer");
    clickSummary();
    // Collapsed: the body is gone; the summary line echoes it truncated.
    // (Scoped to .prose — the reply composer below is a Tiptap editor whose
    // empty state renders a placeholder <p> of its own.)
    expect(container!.querySelector(".prose strong, .prose p")).toBeNull();
    expect(container!.querySelector("button")?.textContent).toBe(
      "the whole answer",
    );
    clickSummary();
    expect(container!.querySelector(".prose p")?.textContent).toBe(
      "the whole answer",
    );
  });

  it("caps the expanded body with an internal scroll", () => {
    render({ response: { kind: "answer", markdown: "long" } });
    expect(container!.querySelector(".overflow-y-auto")).not.toBeNull();
    expect(container!.querySelector(".max-h-80")).not.toBeNull();
  });

  it("shows the fallback assistant text expanded when widget_respond was never called", async () => {
    render({ fallbackText: "last assistant words" });
    await settleMarkdown();
    expect(container!.querySelector("p")?.textContent).toBe(
      "last assistant words",
    );
  });
});
