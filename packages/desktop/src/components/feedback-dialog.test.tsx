import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { CoreProvider } from "@notefig/core/react";
import { createTestCore } from "@/testing/test-core";
import { kvModule } from "@/modules/kv";
import { workspacesModule } from "@/modules/workspaces";
import { FeedbackDialog } from "./feedback-dialog";
import { closeFeedbackDialog, openFeedbackDialog } from "@/hooks/use-feedback-dialog";
// Initializes the shared i18n instance so t() resolves the English strings.
import "@/utils/intl";

vi.mock("@/utils/feedback", () => ({ sendFeedback: vi.fn() }));
const { sendFeedback } = await import("@/utils/feedback");

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  const core = createTestCore({ modules: [kvModule, workspacesModule] });
  await core.boot();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      createElement(
        MemoryRouter,
        null,
        createElement(QueryClientProvider, {
          client: core.use("queryClient"),
          children: createElement(CoreProvider, { core, children: createElement(FeedbackDialog) }),
        }),
      ),
    );
  });
});

afterEach(() => {
  act(() => {
    closeFeedbackDialog();
    root.unmount();
  });
  container.remove();
  vi.mocked(sendFeedback).mockReset();
});

function byText(tag: string, text: string): HTMLElement {
  const match = [...document.querySelectorAll<HTMLElement>(tag)].find(
    (element) => element.textContent === text,
  );
  if (!match) throw new Error(`no <${tag}> "${text}"`);
  return match;
}

function type(text: string) {
  const textarea = document.querySelector("textarea")!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setValue.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit() {
  await act(async () => {
    byText("button", "Send").click();
  });
}

describe("FeedbackDialog", () => {
  it("warns that feedback is public and holds Send until the message is long enough", () => {
    act(() => openFeedbackDialog());
    expect(document.body.textContent).toContain("public issue tracker on GitHub");
    type("short");
    expect(byText("button", "Send")).toHaveProperty("disabled", true);
    type("The sidebar forgets its width");
    expect(byText("button", "Send")).toHaveProperty("disabled", false);
  });

  it("sends the chosen kind and message, then thanks the user", async () => {
    vi.mocked(sendFeedback).mockResolvedValue("sent");
    act(() => openFeedbackDialog());
    act(() => byText("button", "Idea").click());
    type("Let me pin a document to the sidebar");
    await submit();
    expect(vi.mocked(sendFeedback).mock.calls[0][1]).toEqual({
      kind: "idea",
      message: "Let me pin a document to the sidebar",
    });
    expect(document.querySelector("[role=status]")?.textContent).toContain("Thanks");
  });

  it("sends no debug report unless the user includes one", async () => {
    vi.mocked(sendFeedback).mockResolvedValue("sent");
    act(() => openFeedbackDialog());
    type("The sidebar forgets its width");
    await submit();
    expect(vi.mocked(sendFeedback).mock.calls[0][1].debugReport).toBeUndefined();
  });

  it("shows the debug report it will send, and sends exactly that", async () => {
    vi.mocked(sendFeedback).mockResolvedValue("sent");
    act(() => openFeedbackDialog());
    type("The sidebar forgets its width");
    act(() => document.querySelector<HTMLElement>("#feedback-debug-report")!.click());
    act(() => byText("button", "Show what's sent").click());
    const preview = document.querySelector("pre")?.textContent ?? "";
    expect(preview).toMatch(/^=== Notefig Debug Report ===/);
    expect(preview).toContain("── Git Status Cache ──");
    await submit();
    expect(vi.mocked(sendFeedback).mock.calls[0][1].debugReport).toBe(preview);
  });

  it("doesn't let a send from before a close land on the next draft", async () => {
    let finish: (result: "sent") => void = () => {};
    vi.mocked(sendFeedback).mockReturnValue(new Promise((resolve) => (finish = resolve)));
    act(() => openFeedbackDialog());
    type("The first message, sent slowly");
    await submit();
    act(() => byText("button", "Cancel").click());
    act(() => openFeedbackDialog());
    type("A second message, not sent yet");
    await act(async () => finish("sent"));
    expect(document.querySelector("[role=status]")).toBeNull();
    expect(document.querySelector("textarea")?.value).toBe("A second message, not sent yet");
  });

  it("keeps the message and explains a daily limit", async () => {
    vi.mocked(sendFeedback).mockResolvedValue("limited");
    act(() => openFeedbackDialog());
    type("Another report for today");
    await submit();
    expect(document.querySelector("[role=alert]")?.textContent).toContain("try again tomorrow");
    expect(document.querySelector("textarea")?.value).toBe("Another report for today");
  });
});
