import { describe, it, expect, afterEach, vi } from "vitest";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

// See prompt-blob-done-state.test.tsx: the widget only uses i18next for
// labels, so the key stands in for the string.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty" as const, init: () => {} },
}));

import { DoneState } from "../ui/prompt-blob";
import { DiffCard } from "../../diff-block/card";
import { parseDiffBlock, patchOf } from "../../diff-block/patch";
import { fakePromptWidgetHost, withHost } from "../../testing/fake-host";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(element: ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(withHost(fakePromptWidgetHost(), element)));
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  document.body.innerHTML = "";
});

function click(target: Element, init: MouseEventInit = {}) {
  act(() => {
    target.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, ...init }),
    );
  });
}

/** Right-click `target`, then pick its menu's "Open in New Tab". */
function openInNewTabFromMenu(target: Element) {
  act(() => {
    target.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
    );
  });
  const item = [...document.querySelectorAll('[role="menuitem"]')].find(
    (node) => node.textContent?.includes("openInNewTab"),
  );
  expect(item).toBeDefined();
  click(item!);
}

function renderDone() {
  const onOpenFile = vi.fn();
  const onOpenChat = vi.fn();
  mount(
    createElement(DoneState, {
      cancelled: false,
      response: null,
      fallbackText: "Done.",
      touchedFiles: ["/ws/notes.md"],
      documentPath: "/ws/doc.md",
      onOpenFile,
      onOpenChat,
      onDismiss: () => {},
    }),
  );
  const chip = [...container!.querySelectorAll("button")].find(
    (button) => button.textContent === "notes.md",
  )!;
  const chat = container!.querySelector(
    'button[aria-label="promptBlobOpenChat"]',
  )!;
  return { onOpenFile, onOpenChat, chip, chat };
}

describe("links in a finished prompt open like the file tree's rows", () => {
  it("a touched file's chip replaces on click and opens a new tab on Mod+click", () => {
    const { onOpenFile, chip } = renderDone();
    click(chip);
    expect(onOpenFile).toHaveBeenLastCalledWith("/ws/notes.md", "replace");
    click(chip, { metaKey: true });
    expect(onOpenFile).toHaveBeenLastCalledWith("/ws/notes.md", "new-tab");
    click(chip, { ctrlKey: true });
    expect(onOpenFile).toHaveBeenLastCalledWith("/ws/notes.md", "new-tab");
  });

  it("a touched file's chip offers Open in New Tab on right-click", () => {
    const { onOpenFile, chip } = renderDone();
    openInNewTabFromMenu(chip);
    expect(onOpenFile).toHaveBeenCalledWith("/ws/notes.md", "new-tab");
  });

  it("the chat button opens the session the same way", () => {
    const { onOpenChat, chat } = renderDone();
    click(chat);
    expect(onOpenChat).toHaveBeenLastCalledWith("replace");
    click(chat, { ctrlKey: true });
    expect(onOpenChat).toHaveBeenLastCalledWith("new-tab");
    openInNewTabFromMenu(chat);
    expect(onOpenChat).toHaveBeenLastCalledWith("new-tab");
  });
});

describe("a diff card's file label", () => {
  function renderCard() {
    const open = vi.fn();
    const diff = parseDiffBlock("diff", patchOf("src/greet.ts", "old\n", "new\n"))!;
    mount(createElement(DiffCard, { diff, file: { label: "src/greet.ts", open } }));
    const label = [...container!.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("greet.ts"),
    )!;
    return { open, label };
  }

  it("replaces on click and opens a new tab on Mod+click or from its menu", () => {
    const { open, label } = renderCard();
    click(label);
    expect(open).toHaveBeenLastCalledWith("replace");
    click(label, { metaKey: true });
    expect(open).toHaveBeenLastCalledWith("new-tab");
    openInNewTabFromMenu(label);
    expect(open).toHaveBeenLastCalledWith("new-tab");
  });
});
