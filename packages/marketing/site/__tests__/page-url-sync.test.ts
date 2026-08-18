import { describe, expect, it } from "vitest";
import { decideSync, isPendingSettled } from "../use-workspace-ready";

describe("decideSync", () => {
  it("reports settled when path and layout agree", () => {
    expect(decideSync("/docs/cli", "/docs/cli", "/docs/quickstart")).toEqual({
      kind: "settled",
      route: "/docs/cli",
    });
  });

  it("follows the path when the path moved (anchor, back/forward)", () => {
    expect(decideSync("/docs/git-server", "/docs/cli", "/docs/cli")).toEqual({
      kind: "follow-path",
      route: "/docs/git-server",
    });
  });

  it("follows the path on first load (no agreed route, empty layout)", () => {
    expect(decideSync("/docs/quickstart", null, null)).toEqual({
      kind: "follow-path",
      route: "/docs/quickstart",
    });
  });

  it("follows the layout when the selection moved (file tree, tabs)", () => {
    expect(decideSync("/docs/quickstart", "/docs/cli", "/docs/quickstart")).toEqual({
      kind: "follow-layout",
      route: "/docs/cli",
    });
  });

  it("leaves the URL alone when a non-doc file is selected", () => {
    expect(decideSync("/docs/cli", null, "/docs/cli")).toEqual({ kind: "none" });
  });
});

describe("isPendingSettled", () => {
  it("nav writes settle when the path shows the target route", () => {
    expect(isPendingSettled({ type: "nav", route: "/docs/cli" }, "/docs/cli", "/docs/cli")).toBe(
      true,
    );
    expect(
      isPendingSettled({ type: "nav", route: "/docs/cli" }, "/docs/quickstart", "/docs/cli"),
    ).toBe(false);
  });

  it("layout writes settle when the selection shows the target route", () => {
    expect(
      isPendingSettled({ type: "layout", route: "/docs/cli" }, "/docs/cli", "/docs/cli"),
    ).toBe(true);
    expect(
      isPendingSettled({ type: "layout", route: "/docs/cli" }, "/docs/cli", "/docs/quickstart"),
    ).toBe(false);
  });

  it("keeps the reconciler hands-off on half-applied commits", () => {
    // The snap-back regression: layout already shows cli, path still behind
    // on quickstart, nav write in flight — nothing may act on this commit.
    expect(
      isPendingSettled({ type: "nav", route: "/docs/cli" }, "/docs/quickstart", "/docs/cli"),
    ).toBe(false);
  });
});
