import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
            children: createElement(FeedbackDialog),
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

const textarea = () =>
  document.querySelector<HTMLTextAreaElement>("textarea[aria-label='Message']");
const button = (label: string) =>
  [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  );
const sentBody = (call = 0) =>
  JSON.parse(String(fetchMock.mock.calls[call][1].body));

function type(text: string) {
  const field = textarea()!;
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setValue.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit() {
  await act(async () => {
    button("Send")!.click();
  });
}

describe("FeedbackDialog", () => {
  it("opens through core.feedback and sends just the message by default", async () => {
    expect(textarea()).toBeNull();
    act(() => core.feedback.open());
    expect(button("Send")!.disabled).toBe(true);

    type("The sidebar flickers");
    await submit();

    expect(sentBody()).toMatchObject({ message: "The sidebar flickers" });
    expect(sentBody()).not.toHaveProperty("debugReport");
    expect(document.body.textContent).toContain("Your feedback reached");
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

  it("starts a fresh form when reopened after a send", async () => {
    act(() => core.feedback.open());
    type("First message");
    await submit();
    act(() => button("Close")!.click());

    act(() => core.feedback.open());
    expect(textarea()!.value).toBe("");
  });

  it("keeps the draft when the send fails, so it can be retried", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 502 }));
    act(() => core.feedback.open());
    type("Crashes on save");
    await submit();

    expect(document.querySelector("[role='alert']")?.textContent).toContain(
      "Couldn't send",
    );
    expect(textarea()!.value).toBe("Crashes on save");

    await submit();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("Your feedback reached");
  });

  it("says so when the sender is rate-limited", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 429 }));
    act(() => core.feedback.open());
    type("Hello");
    await submit();
    expect(document.querySelector("[role='alert']")?.textContent).toContain(
      "one message a minute",
    );
  });
});
