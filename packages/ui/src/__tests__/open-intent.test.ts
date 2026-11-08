import { describe, expect, it } from "vitest";
import { openIntentOf } from "../open-intent";

describe("openIntentOf", () => {
  const click = (init: { metaKey?: boolean; ctrlKey?: boolean } = {}) => ({
    metaKey: false,
    ctrlKey: false,
    ...init,
  });

  it("replaces on a plain click", () => {
    expect(openIntentOf(click())).toBe("replace");
  });

  it("opens a new tab on Mod+click, ⌘ or Ctrl", () => {
    expect(openIntentOf(click({ metaKey: true }))).toBe("new-tab");
    expect(openIntentOf(click({ ctrlKey: true }))).toBe("new-tab");
  });
});
