import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { defineModule, type Core } from "@notefig/core";
import { CoreProvider } from "@notefig/core/react";
import { createTestCore } from "@/testing/test-core";
import { workspacesModule } from "@/modules/workspaces";
import { createFeedback } from "@/modules/feedback";
import { FeedbackDialog } from "@/modules/feedback/react";
// Initializes the shared i18n instance so t() resolves the English strings.
import "@/utils/intl";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let core: Core;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
  const feedback = createFeedback({
    supportUrl: "https://support.notefig.com",
    fetchFn: fetchMock as unknown as typeof fetch,
  });
  core = createTestCore({
    modules: [
      workspacesModule,
      defineModule({ name: "feedback", register: () => feedback }),
    ],
  });
  await core.boot();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      createElement(
        MemoryRouter,
        null,
        createElement(
          QueryClientProvider,
          { client: new QueryClient() },
          createElement(CoreProvider, {
            core,
            children: [
              createElement(FeedbackDialog, { key: "dialog" }),
              createElement(Toaster, { key: "toaster" }),
            ],
          }),
        ),
      ),
    ),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

import type { Editor } from "@tiptap/core";

/** The message editor's element; Tiptap hangs the editor off it. */
const messageEditor = () =>
  document.querySelector<HTMLElement & { editor: Editor }>(
    "[aria-label='Message']",
  );
const button = (label: string) =>
  [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  );
const sentBody = (call = 0) =>
  JSON.parse(String(fetchMock.mock.calls[call][1].body));

/** Writes markdown into the message, as typing or pasting it would. */
function type(markdown: string) {
  act(() => {
    messageEditor()!.editor.commands.setContent(markdown, { emitUpdate: true });
  });
}

async function submit() {
  await act(async () => {
    button("Send")!.click();
  });
}

describe("FeedbackDialog", () => {
  it("sends the message as markdown, closes, and says so in a snackbar", async () => {
    expect(messageEditor()).toBeNull();
    act(() => core.feedback.open());
    expect(button("Send")!.disabled).toBe(true);

    type("The sidebar **flickers**\n\n- on rename");
    await submit();

    expect(sentBody()).toMatchObject({
      message: "The sidebar **flickers**\n\n- on rename",
    });
    expect(sentBody()).not.toHaveProperty("debugReport");
    expect(core.feedback.isOpen()).toBe(false);
    // Sonner renders its toasts a tick later.
    await act(() => vi.waitFor(() =>
      expect(document.body.textContent).toContain("Feedback sent. Thank you!"),
    ));
  });

  it("attaches the debug report when the box is ticked", async () => {
    act(() => core.feedback.open());
    type("Crashes on save");
    act(() => {
      document.querySelector<HTMLButtonElement>("[role='checkbox']")!.click();
    });
    await submit();

    expect(sentBody().debugReport).toMatch(/^=== Notefig Debug Report ===/);
  });

  it("opens and closes with Mod+Shift+M", () => {
    const press = () =>
      act(() => {
        document.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "M",
            code: "KeyM",
            // jsdom isn't a Mac, so "Mod" is Control here.
            ctrlKey: true,
            shiftKey: true,
            bubbles: true,
          }),
        );
      });
    press();
    expect(core.feedback.isOpen()).toBe(true);
    press();
    expect(core.feedback.isOpen()).toBe(false);
  });

  it("starts a fresh form after a send", async () => {
    act(() => core.feedback.open());
    type("First message");
    await submit();

    act(() => core.feedback.open());
    expect(messageEditor()!.textContent).toBe("");
  });

  it("reopens on the draft with the error when the send fails, for a retry", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 502 }));
    act(() => core.feedback.open());
    type("Crashes on save");
    await submit();

    expect(core.feedback.isOpen()).toBe(true);
    expect(document.querySelector("[role='alert']")?.textContent).toContain(
      "Couldn't send",
    );
    expect(messageEditor()!.textContent).toBe("Crashes on save");

    await submit();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(core.feedback.isOpen()).toBe(false);
  });

  it("says so when the sender is rate-limited", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 429 }));
    act(() => core.feedback.open());
    type("Hello");
    await submit();
    expect(core.feedback.isOpen()).toBe(true);
    expect(document.querySelector("[role='alert']")?.textContent).toContain(
      "One message a minute",
    );
  });

  it("won't send a message longer than the Worker takes", () => {
    act(() => core.feedback.open());
    type("x".repeat(5001));
    expect(button("Send")!.disabled).toBe(true);
    expect(document.querySelector("[role='alert']")?.textContent).toContain(
      "under 5,000",
    );
  });
});
