import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FeedbackDialog } from "@/components/feedback-dialog";
import { openFeedbackDialog } from "@/utils/feedback";
// Initializes the shared i18n instance so t() resolves the English strings.
import "@/utils/intl";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      createElement(FeedbackDialog, {
        supportUrl: "https://support.notefig.com",
      }),
    ),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const textarea = () =>
  document.querySelector<HTMLTextAreaElement>("textarea[aria-label='Message']");
const button = (label: string) =>
  [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  );

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
  it("opens from the command palette's event and sends the message", async () => {
    expect(textarea()).toBeNull();
    act(() => openFeedbackDialog());
    expect(button("Send")!.disabled).toBe(true);

    type("The sidebar flickers");
    await submit();

    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body).toMatchObject({ kind: "bug", message: "The sidebar flickers" });
    expect(document.body.textContent).toContain("Your feedback reached");
  });

  it("starts a fresh form when reopened after a send", async () => {
    act(() => openFeedbackDialog());
    type("First message");
    await submit();
    act(() => button("Close")!.click());

    act(() => openFeedbackDialog());
    expect(textarea()!.value).toBe("");
  });

  it("keeps the draft when the send fails, so it can be retried", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 502 }));
    act(() => openFeedbackDialog());
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
    act(() => openFeedbackDialog());
    type("Hello");
    await submit();
    expect(document.querySelector("[role='alert']")?.textContent).toContain(
      "Too many messages",
    );
  });
});
