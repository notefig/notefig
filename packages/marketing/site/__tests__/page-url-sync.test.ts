import { describe, expect, it } from "vitest";
import {
  decideSync,
  isPendingSettled,
  selectedTabsInLayout,
} from "../use-workspace-ready";

const window_ = (id: string, selected: string, children = [selected]) => ({
  type: "Window" as const,
  id,
  children,
  selected,
  size: 1,
});

describe("selectedTabsInLayout", () => {
  it("reports one selection per window, primary first", () => {
    expect(
      selectedTabsInLayout([
        window_("editor-window", "notefig/docs/cli.md"),
        window_("second", "notefig/download.md"),
      ]),
    ).toEqual(["notefig/docs/cli.md", "notefig/download.md"]);
  });

  it("descends into panels", () => {
    expect(
      selectedTabsInLayout([
        {
          type: "Panel" as const,
          id: "panel",
          size: 1,
          children: [window_("a", "notefig/docs/cli.md")],
        },
      ]),
    ).toEqual(["notefig/docs/cli.md"]);
  });

  it("is empty for a layout with nothing open", () => {
    expect(selectedTabsInLayout([])).toEqual([]);
  });
});

describe("decideSync", () => {
  it("reports settled when path and layout agree", () => {
    expect(decideSync("/docs/cli", ["/docs/cli"], "/docs/quickstart")).toEqual({
      kind: "settled",
      route: "/docs/cli",
    });
  });

  it("is settled while the URL's page is open in any window", () => {
    // Split layout: the page a link opened lives in the second window.
    // Treating only the primary window as authoritative would drag the URL
    // back to the first window's page the moment the visitor clicked.
    expect(
      decideSync("/download", ["/docs/cli", "/download"], "/download"),
    ).toEqual({ kind: "settled", route: "/download" });
  });

  it("follows the path when the path moved (link, back/forward)", () => {
    expect(
      decideSync("/docs/git-server", ["/docs/cli"], "/docs/cli"),
    ).toEqual({ kind: "follow-path", route: "/docs/git-server" });
  });

  it("follows the path on first load (no agreed route, empty layout)", () => {
    expect(decideSync("/docs/quickstart", [], null)).toEqual({
      kind: "follow-path",
      route: "/docs/quickstart",
    });
  });

  it("follows the primary window when the selection moved", () => {
    expect(
      decideSync("/docs/quickstart", ["/docs/cli"], "/docs/quickstart"),
    ).toEqual({ kind: "follow-layout", route: "/docs/cli" });
  });

  it("leaves the URL alone when a non-page file is selected", () => {
    expect(decideSync("/docs/cli", [], "/docs/cli")).toEqual({ kind: "none" });
  });
});

describe("isPendingSettled", () => {
  it("nav writes settle when the path shows the target route", () => {
    expect(
      isPendingSettled({ type: "nav", route: "/docs/cli" }, "/docs/cli", [
        "/docs/cli",
      ]),
    ).toBe(true);
    expect(
      isPendingSettled({ type: "nav", route: "/docs/cli" }, "/docs/quickstart", [
        "/docs/cli",
      ]),
    ).toBe(false);
  });

  it("layout writes settle when the page is selected in ANY window", () => {
    // The deadlock this guards: openFileInLayout selects an already-open tab
    // wherever it lives, so in a split layout the page lands in the second
    // window. Waiting on the primary selection never settles, and the
    // reconciler stays hands-off forever — URL and tabs stop syncing for the
    // rest of the session.
    expect(
      isPendingSettled({ type: "layout", route: "/download" }, "/download", [
        "/docs/cli",
        "/download",
      ]),
    ).toBe(true);
    expect(
      isPendingSettled({ type: "layout", route: "/download" }, "/download", [
        "/docs/cli",
      ]),
    ).toBe(false);
  });

  it("keeps the reconciler hands-off on half-applied commits", () => {
    // The snap-back regression: layout already shows cli, path still behind
    // on quickstart, nav write in flight — nothing may act on this commit.
    expect(
      isPendingSettled({ type: "nav", route: "/docs/cli" }, "/docs/quickstart", [
        "/docs/cli",
      ]),
    ).toBe(false);
  });
});
