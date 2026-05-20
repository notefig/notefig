import { describe, expect, it } from "vitest";
import {
  BLOCK_SELECTION_SHADOW_INPUT_CLASS,
  isDockableHotkeyFocusTarget,
} from "../dockable-hotkeys";

describe("isDockableHotkeyFocusTarget", () => {
  it("returns true when focus is inside the dockable root", () => {
    const dockable = document.createElement("div");
    const editor = document.createElement("div");
    dockable.append(editor);
    document.body.append(dockable);

    expect(isDockableHotkeyFocusTarget(editor, dockable)).toBe(true);

    dockable.remove();
  });

  it("returns true when focus is on the block-selection shadow input", () => {
    const dockable = document.createElement("div");
    const shadowInput = document.createElement("input");
    shadowInput.className = BLOCK_SELECTION_SHADOW_INPUT_CLASS;
    document.body.append(dockable, shadowInput);

    expect(isDockableHotkeyFocusTarget(shadowInput, dockable)).toBe(true);

    dockable.remove();
    shadowInput.remove();
  });

  it("returns false when focus is outside dockable and not block selection", () => {
    const dockable = document.createElement("div");
    const sidebarInput = document.createElement("input");
    document.body.append(dockable, sidebarInput);

    expect(isDockableHotkeyFocusTarget(sidebarInput, dockable)).toBe(false);

    dockable.remove();
    sidebarInput.remove();
  });
});
