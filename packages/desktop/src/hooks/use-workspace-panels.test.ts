import { describe, expect, it } from "vitest";
import { readSidebarView } from "./use-workspace-panels";

describe("readSidebarView", () => {
  it("defaults to the Everything view when nothing is selected", () => {
    expect(readSidebarView(new URLSearchParams(""))).toBe("everything");
  });

  it("reads every known view", () => {
    for (const view of ["everything", "files", "search", "git", "sessions"]) {
      expect(readSidebarView(new URLSearchParams({ sidebarView: view }))).toBe(
        view,
      );
    }
  });

  it("falls back past an unknown value rather than rendering nothing", () => {
    expect(
      readSidebarView(new URLSearchParams({ sidebarView: "welcome" })),
    ).toBe("everything");
  });
});
