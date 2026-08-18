import { describe, expect, it } from "vitest";
import { isPlainLeftClick } from "../docs-nav";

const plainClick = {
  button: 0,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  defaultPrevented: false,
};

describe("isPlainLeftClick", () => {
  it("claims an ordinary left click for client-side navigation", () => {
    expect(isPlainLeftClick(plainClick)).toBe(true);
  });

  it("leaves modified and non-left clicks to the browser", () => {
    // Cmd/Ctrl-click opens a new tab, shift a new window, alt downloads —
    // all of which need the real href, not a router navigation.
    for (const modifier of [
      "metaKey",
      "ctrlKey",
      "shiftKey",
      "altKey",
    ] as const) {
      expect(isPlainLeftClick({ ...plainClick, [modifier]: true })).toBe(false);
    }
    expect(isPlainLeftClick({ ...plainClick, button: 1 })).toBe(false);
    expect(isPlainLeftClick({ ...plainClick, defaultPrevented: true })).toBe(
      false,
    );
  });
});
