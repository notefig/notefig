import { describe, expect, it } from "vitest";
import { decideSync, isPendingSettled } from "../use-docs-workspace";

describe("decideSync", () => {
  it("reports settled when path and layout agree", () => {
    expect(decideSync("cli", "cli", "quickstart")).toEqual({
      kind: "settled",
      slug: "cli",
    });
  });

  it("follows the path when the path moved (anchor, back/forward)", () => {
    expect(decideSync("git-server", "cli", "cli")).toEqual({
      kind: "follow-path",
      slug: "git-server",
    });
  });

  it("follows the path on first load (no agreed slug, empty layout)", () => {
    expect(decideSync("quickstart", null, null)).toEqual({
      kind: "follow-path",
      slug: "quickstart",
    });
  });

  it("follows the layout when the selection moved (file tree, tabs)", () => {
    expect(decideSync("quickstart", "cli", "quickstart")).toEqual({
      kind: "follow-layout",
      slug: "cli",
    });
  });

  it("leaves the URL alone when a non-doc file is selected", () => {
    expect(decideSync("cli", null, "cli")).toEqual({ kind: "none" });
  });
});

describe("isPendingSettled", () => {
  it("nav writes settle when the path shows the target slug", () => {
    expect(isPendingSettled({ type: "nav", slug: "cli" }, "cli", "cli")).toBe(
      true,
    );
    expect(
      isPendingSettled({ type: "nav", slug: "cli" }, "quickstart", "cli"),
    ).toBe(false);
  });

  it("layout writes settle when the selection shows the target slug", () => {
    expect(
      isPendingSettled({ type: "layout", slug: "cli" }, "cli", "cli"),
    ).toBe(true);
    expect(
      isPendingSettled({ type: "layout", slug: "cli" }, "cli", "quickstart"),
    ).toBe(false);
  });

  it("keeps the reconciler hands-off on half-applied commits", () => {
    // The snap-back regression: layout already shows cli, path still behind
    // on quickstart, nav write in flight — nothing may act on this commit.
    expect(
      isPendingSettled({ type: "nav", slug: "cli" }, "quickstart", "cli"),
    ).toBe(false);
  });
});
