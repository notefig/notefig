import { describe, it, expect, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createElement, type ReactNode } from "react";

// react-i18next resolves the hoisted root React copy under vitest (hooks
// break across instances); the view only uses it for labels, so stub it.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty" as const, init: () => {} },
}));

import { WidgetResponseView } from "../ui/widget-response-view";
import type { WidgetResponse } from "@notefig/shared/agent";
import { fakePromptWidgetHost, withHost } from "../../testing/fake-host";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function render(props: {
  response: WidgetResponse | null;
  fallbackText?: string | null;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      withHost(fakePromptWidgetHost(), createElement(WidgetResponseView, props)),
    ),
  );
}

function body(): HTMLElement | null {
  return container!.querySelector('[data-testid="markdown"]');
}

function heading(): HTMLButtonElement {
  return container!.querySelector("button")!;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

describe("WidgetResponseView", () => {
  it("renders the response markdown through the host slot, headed by its title", () => {
    render({ response: { kind: "answer", markdown: "**bold**", title: "Summary" } });
    expect(body()?.textContent).toBe("**bold**");
    expect(heading().textContent).toBe("Summary");
    expect(
      container!.querySelector("[data-widget-response]")?.getAttribute(
        "data-widget-response",
      ),
    ).toBe("answer");
  });

  it("falls back to the Done label when the response has no title", () => {
    render({ response: { kind: "answer", markdown: "body" } });
    expect(heading().textContent).toBe("promptBlobDone");
  });

  it("an issue gets the Issue heading and the warning tint", () => {
    render({ response: { kind: "issue", markdown: "blocked" } });
    expect(heading().textContent).toBe("promptBlobIssue");
    expect(body()?.className).toContain("text-warning");
    expect(
      container!.querySelector("[data-widget-response]")?.getAttribute(
        "data-widget-response",
      ),
    ).toBe("issue");
  });

  it("the heading collapses the body to a one-line summary and back", () => {
    render({ response: { kind: "answer", markdown: "the whole answer" } });
    act(() => heading().click());
    expect(body()).toBeNull();
    expect(heading().textContent).toBe("the whole answer");
    act(() => heading().click());
    expect(body()?.textContent).toBe("the whole answer");
  });

  it("defaultExpanded={false} lands on the one-line summary", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root!.render(
        withHost(
          fakePromptWidgetHost(),
          createElement(WidgetResponseView, {
            response: { kind: "answer", markdown: "body", title: "Summary" },
            defaultExpanded: false,
          }),
        ),
      ),
    );
    expect(body()).toBeNull();
    expect(heading().textContent).toBe("Summary");
    act(() => heading().click());
    expect(body()?.textContent).toBe("body");
  });

  it("offers copy only when there is a body", () => {
    render({ response: { kind: "answer", markdown: "copy me" } });
    expect(container!.querySelectorAll("button")).toHaveLength(2);
    act(() => root?.unmount());
    container?.remove();
    render({ response: null });
    expect(container!.querySelectorAll("button")).toHaveLength(1);
    expect(heading().disabled).toBe(true);
  });

  it("places the caller's actions in the heading row and children below", () => {
    render({
      response: { kind: "answer", markdown: "x" },
      actions: createElement("span", { "data-testid": "action" }),
      children: createElement("span", { "data-testid": "below" }),
    });
    const action = container!.querySelector('[data-testid="action"]')!;
    const below = container!.querySelector('[data-testid="below"]')!;
    expect(action.parentElement).toBe(heading().parentElement);
    expect(
      body()!.compareDocumentPosition(below) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
