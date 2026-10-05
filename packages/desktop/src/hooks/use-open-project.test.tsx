import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { CoreProvider } from "@notefig/core/react";

// The layout hook lives in the tabs entity, whose module graph reaches the
// persisted agent collections; give them the in-memory rig.
vi.mock("@/adapters", async () => ({
  platformAdapter: {
    db: (await import("@/testing/node-db")).createNodeTestDb(),
  },
}));

const workspaces = vi.hoisted(() => ({
  open: new Set<string>(),
  // What the registry did on `workspace:focused` (see `registry` below).
  focused: vi.fn((_path: string) => {}),
  workspaceOfPath: (path: string) =>
    [...workspaces.open].find((ws) => path.startsWith(`${ws}/`)) ?? null,
}));
vi.mock("@/entities/workspaces", () => workspaces);
const scratchpads = vi.hoisted(() => ({
  enterScratchpad: vi.fn(
    async (ws: string, _keep: readonly string[]): Promise<string | null> =>
      `${ws}/.notefig/scratchpads/sunny-otter.md`,
  ),
  sweepScratchpads: vi.fn(async (_ws: string, _keep: readonly string[]) => {}),
}));
vi.mock("@/entities/scratchpads", () => scratchpads);
const recents = vi.hoisted(() => ({ addRecentProject: vi.fn() }));
vi.mock("./use-recent-projects", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./use-recent-projects")>()),
  useRecentProjects: () => recents,
}));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import { useOpenProject } from "./use-open-project";
import { LAYOUT_PARAM, extractTabIds, parseLayout } from "@/utils/layout-codec";
import { urlStateFromRouter } from "@/entities/layout";
import { defineModule } from "@notefig/core";
import { scratchpadLandingModule } from "@/entities/scratchpad-landing";
import { sidebarViewModule } from "./sidebar-view";
import { tabsModule } from "@/entities/tabs";
import { createTestCore } from "@/testing/test-core";

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let openProject: ((path: string) => Promise<boolean>) | undefined;
let router: ReturnType<typeof createMemoryRouter>;
let core: ReturnType<typeof createTestCore>;

/** The registry's part of a focus, as the landing relies on it: the
 *  workspace is in the open set before anything lands in it. */
const registry = defineModule({
  name: "workspace-registry",
  boot: (_api, ctx) =>
    ctx.hooks.on("workspace:focused", ({ path }) => {
      workspaces.open.add(path);
      workspaces.focused(path);
    }),
});

function Probe() {
  openProject = useOpenProject();
  return null;
}

async function tick(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function openTabs(): string[] {
  const search = router.state.location.search;
  return extractTabIds(
    parseLayout(new URLSearchParams(search).get(LAYOUT_PARAM)),
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  workspaces.open.clear();
  router = createMemoryRouter([{ path: "*", element: createElement(Probe) }]);
  core = createTestCore({
    url: urlStateFromRouter(router),
    modules: [
      tabsModule({ canOpenFile: () => true }),
      registry,
      scratchpadLandingModule,
      sidebarViewModule,
    ],
  });
  core.boot();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      createElement(CoreProvider, {
        core,
        children: createElement(RouterProvider, { router }),
      }),
    );
  });
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
});

describe("entering a project (useOpenProject)", () => {
  it("first open: records recency, opens + focuses, and lands in the scratchpad as a new tab", async () => {
    await act(async () => {
      await openProject!("/ws");
    });
    await tick();

    expect(recents.addRecentProject).toHaveBeenCalledWith("/ws");
    expect(workspaces.focused).toHaveBeenCalledWith("/ws");
    expect(scratchpads.enterScratchpad).toHaveBeenCalledWith("/ws", []);
    expect(openTabs()).toEqual(["/ws/.notefig/scratchpads/sunny-otter.md"]);
  });

  it("re-entry with none of its files open lands in a scratchpad again", async () => {
    await act(async () => {
      await openProject!("/ws");
    });
    await tick();
    // The user closed the scratchpad tab, then reopened the project.
    await act(async () => {
      await router.navigate("/", { replace: true });
    });
    vi.clearAllMocks();

    await act(async () => {
      await openProject!("/ws");
    });
    await tick();

    expect(workspaces.focused).toHaveBeenCalledWith("/ws");
    expect(scratchpads.enterScratchpad).toHaveBeenCalledWith("/ws", []);
    expect(openTabs()).toEqual(["/ws/.notefig/scratchpads/sunny-otter.md"]);
  });

  it("re-open of an open workspace with a file tab only brings it to the front — sweep, no landing, tabs untouched", async () => {
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
    // The entry sweep still runs, keeping the tab that is open.
    expect(scratchpads.sweepScratchpads).toHaveBeenCalledWith("/ws", [
      "/ws/.notefig/scratchpads/sunny-otter.md",
    ]);
    expect(workspaces.focused).toHaveBeenCalledWith("/ws");
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
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
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

  it("entering shows the workspace's files in a sidebar on the Everything view, and leaves a chosen tool alone", async () => {
    await act(async () => {
      await openProject!("/ws-a");
    });
    expect(
      new URLSearchParams(router.state.location.search).get("sidebarView"),
    ).toBe("files");

    await act(async () => {
      await router.navigate("/?sidebarView=search", { replace: true });
      await openProject!("/ws-b");
    });
    expect(
      new URLSearchParams(router.state.location.search).get("sidebarView"),
    ).toBe("search");
  });

  it("focusing a workspace brings it forward without landing anything", async () => {
    await act(async () => {
      await core.workspace("/ws").focus();
    });

    expect(workspaces.focused).toHaveBeenCalledWith("/ws");
    expect(scratchpads.enterScratchpad).not.toHaveBeenCalled();
    expect(scratchpads.sweepScratchpads).not.toHaveBeenCalled();
    expect(openTabs()).toEqual([]);
  });

  it("a failed open is reported and resolves false, never rejects", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    scratchpads.enterScratchpad.mockRejectedValueOnce(new Error("disk gone"));
    let opened: boolean | undefined;
    await act(async () => {
      opened = await openProject!("/ws");
    });

    expect(opened).toBe(false);
    expect(quiet).toHaveBeenCalledWith(
      "Failed to open /ws:",
      expect.objectContaining({ name: "WorkspaceOpenError" }),
    );
    quiet.mockRestore();
  });
});
