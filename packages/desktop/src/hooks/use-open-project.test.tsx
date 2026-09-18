import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserRouter, useLocation } from "react-router-dom";

// The layout hook lives in the tabs entity, whose module graph reaches the
// persisted agent collections; give them the in-memory rig.
vi.mock("@/adapters", async () => ({
  platformAdapter: {
    db: (await import("@/testing/node-db")).createNodeTestDb(),
  },
}));

const workspaces = vi.hoisted(() => ({
  open: new Set<string>(),
  // Open-or-focus: the entity's one verb.
  openWorkspace: vi.fn(async (path: string) => {
    workspaces.open.add(path);
  }),
  workspaceOfPath: (path: string) =>
    [...workspaces.open].find((ws) => path.startsWith(`${ws}/`)) ?? null,
}));
vi.mock("@/entities/workspaces", () => workspaces);
const scratchpads = vi.hoisted(() => ({
  enterScratchpad: vi.fn(
    async (ws: string, _keep: readonly string[]): Promise<string | null> =>
      `${ws}/.notefig/scratchpads/sunny-otter.md`,
  ),
}));
vi.mock("@/entities/scratchpads", () => scratchpads);
const watchers = vi.hoisted(() => ({ ensureWatching: vi.fn() }));
vi.mock("@/utils/workspace-watchers", () => watchers);
const recents = vi.hoisted(() => ({ addRecentProject: vi.fn() }));
vi.mock("./use-recent-projects", () => ({
  useRecentProjects: () => recents,
}));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import { showWorkspace, useOpenProject } from "./use-open-project";
import { LAYOUT_PARAM, extractTabIds, parseLayout } from "@/utils/layout-codec";

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let openProject: ((path: string) => Promise<void>) | undefined;
let search = "";

function Probe() {
  openProject = useOpenProject();
  const location = useLocation();
  useEffect(() => {
    search = location.search;
  });
  return null;
}

async function tick(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function openTabs(): string[] {
  return extractTabIds(
    parseLayout(new URLSearchParams(search).get(LAYOUT_PARAM)),
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  workspaces.open.clear();
  search = "";
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      // A real history: the sweep's keep-list comes from a one-shot read
      // of window.location, like every non-React layout reader.
      createElement(BrowserRouter, { children: createElement(Probe) }),
    );
  });
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  window.history.replaceState(null, "", "/");
});

describe("useOpenProject", () => {
  it("first open: records recency, opens + focuses, and lands in the scratchpad as a new tab", async () => {
    await act(async () => {
      await openProject!("/ws");
    });
    await tick();

    expect(recents.addRecentProject).toHaveBeenCalledWith("/ws");
    expect(workspaces.openWorkspace).toHaveBeenCalledWith("/ws");
    expect(watchers.ensureWatching).toHaveBeenCalledWith("/ws");
    expect(scratchpads.enterScratchpad).toHaveBeenCalledWith("/ws", []);
    expect(openTabs()).toEqual(["/ws/.notefig/scratchpads/sunny-otter.md"]);
  });

  it("re-entry with none of its files open lands in a scratchpad again", async () => {
    await act(async () => {
      await openProject!("/ws");
    });
    await tick();
    // The user closed the scratchpad tab, then reopened the project.
    window.history.replaceState(null, "", "/");
    vi.clearAllMocks();

    await act(async () => {
      await openProject!("/ws");
    });
    await tick();

    expect(workspaces.openWorkspace).toHaveBeenCalledWith("/ws");
    expect(scratchpads.enterScratchpad).toHaveBeenCalledWith("/ws", []);
    expect(openTabs()).toEqual(["/ws/.notefig/scratchpads/sunny-otter.md"]);
  });

  it("re-open of an open workspace with a file tab only brings it to the front — no scratchpad, tabs untouched", async () => {
    await act(async () => {
      await openProject!("/ws");
    });
    await tick();
    vi.clearAllMocks();

    await act(async () => {
      await openProject!("/ws");
    });
    await tick();

    expect(scratchpads.enterScratchpad).not.toHaveBeenCalled();
    expect(workspaces.openWorkspace).toHaveBeenCalledWith("/ws");
    expect(openTabs()).toEqual(["/ws/.notefig/scratchpads/sunny-otter.md"]);
  });

  it("opening a second project adds to the dock rather than replacing it", async () => {
    await act(async () => {
      await openProject!("/ws-a");
    });
    await tick();
    await act(async () => {
      await openProject!("/ws-b");
    });
    await tick();

    // The first project's open tab is what the sweep must keep.
    expect(scratchpads.enterScratchpad).toHaveBeenLastCalledWith("/ws-b", [
      "/ws-a/.notefig/scratchpads/sunny-otter.md",
    ]);
    expect(openTabs()).toEqual([
      "/ws-a/.notefig/scratchpads/sunny-otter.md",
      "/ws-b/.notefig/scratchpads/sunny-otter.md",
    ]);
  });

  it("two overlapping opens of one project enter the scratchpad once and open one tab", async () => {
    // The open is a user gesture, but nothing serialises gestures: a second
    // call can arrive before the first has finished its disk work. Both
    // would see no open file tab, both would sweep and create — two
    // scratchpads on disk, two tabs in the dock.
    let release!: () => void;
    scratchpads.enterScratchpad.mockImplementationOnce(
      (ws: string) =>
        new Promise<string | null>((resolve) => {
          release = () =>
            resolve(`${ws}/.notefig/scratchpads/sunny-otter.md`);
        }),
    );
    let first!: Promise<void>;
    let second!: Promise<void>;
    await act(async () => {
      first = openProject!("/ws");
      second = openProject!("/ws");
      await tick();
      release();
      await Promise.all([first, second]);
    });
    await tick();

    expect(scratchpads.enterScratchpad).toHaveBeenCalledTimes(1);
    expect(openTabs()).toEqual(["/ws/.notefig/scratchpads/sunny-otter.md"]);
  });

  it("scratchpad-on-startup off: opens with no new tab", async () => {
    scratchpads.enterScratchpad.mockResolvedValueOnce(null);
    await act(async () => {
      await openProject!("/ws");
    });
    await tick();

    expect(openTabs()).toEqual([]);
  });

  it("showWorkspace opens-or-focuses and re-arms the watcher", () => {
    showWorkspace("/ws");
    expect(workspaces.openWorkspace).toHaveBeenCalledWith("/ws");
    expect(watchers.ensureWatching).toHaveBeenCalledWith("/ws");
  });
});
