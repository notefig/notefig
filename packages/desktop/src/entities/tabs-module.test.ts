import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LayoutNode } from "@/components/dockable";

// core.tabs and core.layout over an in-memory URL. The tab surfaces are
// stubbed: what is under test is which tabs the layout holds, what gets
// disposed, and which window is active.
const controllers = vi.hoisted(() => ({
  disposed: [] as string[],
  focusTab: vi.fn(() => true),
  requestTabFocus: vi.fn(),
  grantTabFocusHandoff: vi.fn(),
}));
vi.mock("@/tabs/tab-controllers", () => ({
  disposeTab: (id: string) => controllers.disposed.push(id),
  focusTab: controllers.focusTab,
  requestTabFocus: controllers.requestTabFocus,
  grantTabFocusHandoff: controllers.grantTabFocusHandoff,
  getTabController: vi.fn(),
  getTabSelectedText: vi.fn(),
  isTabFocusable: vi.fn(),
  revealTabMatch: vi.fn(),
  searchTab: vi.fn(),
}));
vi.mock("./workspaces", () => ({
  useOpenWorkspacesReady: vi.fn(() => true),
  useOpenWorkspaces: vi.fn(() => []),
  workspaceOfPath: vi.fn(() => null),
}));
vi.mock("@/entities/files", () => ({
  getOrCreateWorkspaceCollections: vi.fn(),
  useMetadataFetching: vi.fn(() => false),
  renameFileOrDirectory: vi.fn(),
}));
vi.mock("./editors", () => ({ editor: vi.fn(), getMarkdownEditor: vi.fn() }));
vi.mock("./agents", () => ({
  agents: { task: vi.fn() },
  agentTasksCollection: { get: vi.fn() },
  useAgentTasksReady: vi.fn(() => true),
  useAgentTaskRowsById: vi.fn(() => []),
}));

import { tabsModule } from "./tabs";
import { createTestCore, memoryUrlState } from "@/testing/test-core";
import type { UrlState } from "./layout";

const win = (
  id: string,
  children: string[],
  selected = children[0],
): LayoutNode => ({ type: "Window", id, children, selected }) as LayoutNode;

let url: UrlState;
let core: ReturnType<typeof createTestCore>;

function setup(layout: LayoutNode[] = [], extraSearch = "") {
  const params = new URLSearchParams(extraSearch);
  if (layout.length) params.set("layout", JSON.stringify(layout));
  url = memoryUrlState(params.size ? `?${params}` : "");
  core = createTestCore({
    url,
    modules: [tabsModule({ canOpenFile: (path) => !path.endsWith(".bin") })],
  });
  core.boot();
}

beforeEach(() => {
  controllers.disposed.length = 0;
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("core.layout", () => {
  it("reads the layout param, returning one reference until it changes", () => {
    setup([win("w1", ["/a.md"])]);
    const first = core.layout.read();
    expect(core.layout.read()).toBe(first);
    expect(core.layout.openTabIds()).toEqual(["/a.md"]);

    core.layout.update((current) => [...current, win("w2", ["/b.md"])]);
    expect(core.layout.read()).not.toBe(first);
    expect(core.layout.openTabIds()).toEqual(["/a.md", "/b.md"]);
  });

  it("keeps other params, drops the param for an empty layout, and notifies only on layout changes", () => {
    setup([win("w1", ["/a.md"])], "settings=open");
    const listener = vi.fn();
    core.layout.subscribe(listener);

    url.setSearch(`${url.search()}&sidebar=files`);
    expect(listener).not.toHaveBeenCalled();

    core.layout.update([]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(url.search()).toBe("?settings=open&sidebar=files");
  });

  it("changes other params in the same write", () => {
    setup([], "settings=open");
    core.layout.update([win("w1", ["/a.md"])], {
      params: (params) => params.delete("settings"),
    });
    const params = new URLSearchParams(url.search());
    expect(params.has("settings")).toBe(false);
    expect(core.layout.openTabIds()).toEqual(["/a.md"]);
  });
});

describe("core.tabs", () => {
  it("opens into the active window, replacing and disposing its selected tab", () => {
    setup([win("w1", ["/a.md"]), win("w2", ["/b.md"])]);
    expect(core.tabs.open("/c.md")).toBe(true);
    expect(core.layout.openTabIds()).toEqual(["/c.md", "/b.md"]);
    expect(controllers.disposed).toEqual(["/a.md"]);
    expect(core.tabs.activeTabId()).toBe("/c.md");
  });

  it("refuses a file the editor cannot open, but not other tab kinds", () => {
    setup([win("w1", ["/a.md"])]);
    expect(core.tabs.open("/blob.bin")).toBe(false);
    expect(core.layout.openTabIds()).toEqual(["/a.md"]);

    core.tabs.openAgent("task_1");
    expect(core.layout.openTabIds()).toEqual(["/a.md", "agent:task_1"]);
    expect(controllers.disposed).toEqual([]);
  });

  it("grants the focus hand-off only for a tab that opened", () => {
    setup([win("w1", ["/a.md"])]);
    core.tabs.open("/blob.bin", { handoff: true });
    expect(controllers.grantTabFocusHandoff).not.toHaveBeenCalled();
    core.tabs.open("/new.md", { handoff: true });
    expect(controllers.grantTabFocusHandoff).toHaveBeenCalledWith("/new.md");
  });

  it("follows focus: the window that last held it is the active one", () => {
    setup([win("w1", ["/a.md"]), win("w2", ["/b.md"])]);
    const listener = vi.fn();
    core.tabs.subscribe(listener);
    expect(core.tabs.activeTabId()).toBe("/a.md");

    const window2 = document.createElement("div");
    window2.dataset.dockableWindowId = "w2";
    const field = document.createElement("input");
    window2.append(field);
    document.body.append(window2);
    field.focus();

    expect(listener).toHaveBeenCalled();
    expect(core.tabs.activeWindowId()).toBe("w2");
    // Still w2 after focus leaves the dock.
    field.blur();
    expect(core.tabs.activeTabId()).toBe("/b.md");
  });

  it("selects, closes and renames without disposing what stays", () => {
    setup([win("w1", ["/a.md", "/b.md"])]);
    core.tabs.select("/b.md");
    expect(core.tabs.activeTabId()).toBe("/b.md");

    core.tabs.rename("/b.md", "/b2.md");
    expect(core.layout.openTabIds()).toEqual(["/a.md", "/b2.md"]);
    expect(controllers.disposed).toEqual([]);

    core.tabs.close("/a.md");
    expect(core.layout.openTabIds()).toEqual(["/b2.md"]);
    expect(controllers.disposed).toEqual(["/a.md"]);
  });

  it("takes a layout from the dock, disposing the tabs it dropped", () => {
    setup([win("w1", ["/a.md", "/b.md"])]);
    core.tabs.applyLayout([win("w1", ["/b.md"])]);
    expect(core.layout.openTabIds()).toEqual(["/b.md"]);
    expect(controllers.disposed).toEqual(["/a.md"]);
  });

  it("focuses now by default, or files an arbitrated intent", () => {
    setup([win("w1", ["/a.md"])]);
    expect(core.tabs.focus("/a.md")).toBe(true);
    expect(controllers.focusTab).toHaveBeenCalledWith("/a.md");

    expect(
      core.tabs.focus("/a.md", { when: "when-mounted", reason: "test" }),
    ).toBe(false);
    expect(controllers.requestTabFocus).toHaveBeenCalledWith("/a.md", {
      when: "when-mounted",
      reason: "test",
      steal: undefined,
    });
  });
});
