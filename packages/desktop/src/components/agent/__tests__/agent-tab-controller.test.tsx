import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useAgentTabController } from "../agent-tab-controller";
import {
  getTabController,
  hasTabController,
  setActiveTab,
} from "@/tabs/tab-controllers";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const TAB_ID = "agent:task_1";

/** A stand-in for the chat tab: same registration + composer wiring. */
function ChatTabStub({ focus }: { focus: () => boolean }) {
  const { rootRef, composerFocusRef } = useAgentTabController("task_1");

  useEffect(() => {
    const box = composerFocusRef.current;
    box.focus = focus;
    return () => {
      box.focus = () => false;
    };
  }, [composerFocusRef, focus]);

  return createElement(
    "div",
    { ref: rootRef },
    createElement("p", null, "hello from the transcript"),
  );
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  setActiveTab(null);
});

function mount(focus: () => boolean = () => true) {
  act(() => {
    root.render(createElement(ChatTabStub, { focus }));
  });
}

describe("agent tab controller", () => {
  it("is published while the tab is mounted and withdrawn on unmount", () => {
    mount();
    expect(getTabController(TAB_ID)?.kind).toBe("agent");

    act(() => root.render(null));
    expect(hasTabController(TAB_ID)).toBe(false);
  });

  it("focuses the composer", () => {
    const focus = vi.fn(() => true);
    mount(focus);

    expect(getTabController(TAB_ID)!.focus()).toBe(true);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("never yanks focus out of another text entry unless told to", () => {
    const focus = vi.fn(() => true);
    mount(focus);

    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();

    expect(getTabController(TAB_ID)!.focus()).toBe(false);
    expect(focus).not.toHaveBeenCalled();

    // An explicit hand-off may.
    expect(getTabController(TAB_ID)!.focus({ steal: true })).toBe(true);
    expect(focus).toHaveBeenCalledTimes(1);

    input.remove();
  });

  it("reports the transcript selection, and only its own", () => {
    mount();
    const controller = getTabController(TAB_ID)!;

    expect(controller.selectedText()).toBeUndefined();

    const paragraph = container.querySelector("p")!;
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    expect(controller.selectedText()).toBe("hello from the transcript");

    const outside = document.createElement("p");
    outside.textContent = "somewhere else";
    document.body.appendChild(outside);
    const outsideRange = document.createRange();
    outsideRange.selectNodeContents(outside);
    selection.removeAllRanges();
    selection.addRange(outsideRange);

    expect(controller.selectedText()).toBeUndefined();
    outside.remove();
  });

  it("closing the tab never tears the session down", () => {
    mount();
    // dispose is deliberately inert: the session outlives its tab.
    expect(() => getTabController(TAB_ID)!.dispose()).not.toThrow();
  });

  it("has find-in-tab wired but not yet implemented (MET-152)", () => {
    mount();
    const controller = getTabController(TAB_ID)!;

    expect(controller.search("transcript")).toEqual([]);
    expect(
      controller.revealMatch({
        matchText: "transcript",
        lineText: "hello from the transcript",
        occurrence: 0,
      }),
    ).toBe(false);
  });
});
