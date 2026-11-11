/**
 * The draft row's session picker (MET-284): its trigger is the mark of the
 * session the next prompt goes to, or the default harness's logo before
 * there is one; its menu lists live sessions by mark, harness name, title.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fakePromptWidgetHost, withHost } from "../../testing/fake-host";
import type { SessionOption } from "../host";
import { SessionPicker } from "../ui/session-picker";

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

const sessions: SessionOption[] = [
  { taskId: "t_pitch", title: "Pitch rewrite", description: "2m ago", harnessId: "claude", colorSlot: 0, shapeSlot: 0 },
  { taskId: "t_price", title: "Pricing table", description: "1h ago", harnessId: "opencode", colorSlot: 1, shapeSlot: 1 },
];

function renderPicker(peeked: string | null, onSelectSession = vi.fn()) {
  const host = fakePromptWidgetHost({
    useSessionList: vi.fn(() => sessions),
    peekSession: vi.fn(() => peeked),
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      withHost(
        host,
        <SessionPicker workspacePath="/ws" onSelectSession={onSelectSession} onClose={vi.fn()} />,
      ),
    ),
  );
  return { host, trigger: container.querySelector<HTMLButtonElement>("[data-session-picker]")! };
}

function openMenu(trigger: HTMLButtonElement) {
  act(() => {
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}

describe("SessionPicker", () => {
  it("shows the mark of the session the next prompt goes to", () => {
    const { trigger } = renderPicker("t_price");
    expect(trigger.dataset.sessionPicker).toBe("t_price");
    expect(trigger.querySelector("[data-session-mark]")?.getAttribute("data-session-mark")).toBe("1:1");
  });

  it("shows the default harness's logo before there is a session", () => {
    const { trigger } = renderPicker(null);
    expect(trigger.querySelector("[data-session-mark]")).toBeNull();
    expect(trigger.querySelector('[data-testid="harness-logo-claude"]')).not.toBeNull();
  });

  it("lists live sessions by mark, harness name and title, marking the target", () => {
    const onSelectSession = vi.fn();
    const { trigger } = renderPicker("t_price", onSelectSession);
    openMenu(trigger);
    const options = [...document.body.querySelectorAll<HTMLElement>("[data-session-option]")];
    expect(options.map((option) => option.textContent)).toEqual([
      "Claude CodePitch rewrite2m ago",
      "opencodePricing table1h ago",
    ]);
    expect(options[0].querySelector("[data-session-mark]")?.getAttribute("data-session-mark")).toBe("0:0");
    expect(options[0].getAttribute("aria-current")).toBeNull();
    expect(options[1].getAttribute("aria-current")).toBe("true");
    act(() => options[0].click());
    expect(onSelectSession).toHaveBeenCalledWith("t_pitch");
  });
});
