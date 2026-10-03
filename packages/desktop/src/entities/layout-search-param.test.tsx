import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

// The tabs entity's module graph reaches the persisted agent collections.
vi.mock("@/adapters", async () => ({
  platformAdapter: {
    db: (await import("@/testing/node-db")).createNodeTestDb(),
  },
}));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import { useLayoutSearchParam } from "./tabs";
import { openFileInLayout } from "@/utils/dockable-layout";
import { LAYOUT_PARAM, extractTabIds, parseLayout } from "@/utils/layout-codec";

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let setLayout: ReturnType<typeof useLayoutSearchParam>["setLayout"] | undefined;

function Probe() {
  ({ setLayout } = useLayoutSearchParam());
  return null;
}

function urlTabs(): string[] {
  return extractTabIds(
    parseLayout(new URLSearchParams(window.location.search).get(LAYOUT_PARAM)),
  );
}

beforeEach(async () => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(BrowserRouter, { children: createElement(Probe) }));
  });
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  window.history.replaceState(null, "", "/");
});

describe("useLayoutSearchParam", () => {
  // Regression: updaters were resolved against the layout of the last
  // render, so a second update landing before the re-render (two quick
  // Mod+clicks in the tree on a busy main thread) dropped the first tab.
  it("applies updates issued before a re-render on top of each other", async () => {
    const openNewTab = (tabId: string) =>
      setLayout!((current) =>
        openFileInLayout(current, { tabId, intent: "new-tab" }),
      );

    await act(async () => {
      openNewTab("/ws/a.md");
      openNewTab("/ws/b.md");
      openNewTab("/ws/c.md");
    });

    expect(urlTabs()).toEqual(["/ws/a.md", "/ws/b.md", "/ws/c.md"]);
  });
});
