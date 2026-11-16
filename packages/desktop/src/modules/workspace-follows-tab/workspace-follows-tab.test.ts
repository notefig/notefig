import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceRegistry, mostRecentlyFocused, type WorkspaceRegistry } from "@/modules/workspaces";
import { agentTabId } from "@/modules/tabs/tab-id";
import { RELEASE_NOTES_TAB_ID } from "@/modules/tabs";
import { createNodeTestDb } from "@/testing/node-db";
import { followActiveTab } from "./workspace-follows-tab";

/** The tabs, as far as this goes: one active tab the test moves. */
function testTabs(initial: string | null = null) {
  let active = initial;
  const listeners = new Set<() => void>();
  return {
    activeTabId: () => active,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    show(tabId: string | null) {
      active = tabId;
      for (const listener of listeners) listener();
    },
  };
}

let registry: WorkspaceRegistry;
let tabs: ReturnType<typeof testTabs>;
let stop: () => void;
const tasks = new Map([["task_b", { workspacePath: "/b" }], ["task_gone", { workspacePath: "/closed" }]]);
const focus = vi.fn((path: string) => registry.recordFocus(path));
const focused = () => mostRecentlyFocused(registry.collection.values())?.path;

async function start(initial: string | null = null) {
  tabs = testTabs(initial);
  stop = followActiveTab({ tabs, registry, tasks, focus });
  await registry.whenReady();
}

beforeEach(async () => {
  vi.useFakeTimers({ now: 1_000, toFake: ["Date"] });
  focus.mockClear();
  registry = createWorkspaceRegistry(createNodeTestDb().get());
  await registry.recordFocus("/a");
  vi.setSystemTime(2_000);
  await registry.recordFocus("/b");
  vi.setSystemTime(3_000);
  await registry.recordFocus("/a");
});

afterEach(() => {
  stop();
  vi.useRealTimers();
});

describe("the focused workspace follows the active tab", () => {
  it("focuses the workspace of a file tab brought forward", async () => {
    await start("/a/one.md");
    vi.setSystemTime(4_000);
    tabs.show("/b/notes/two.md");

    await vi.waitFor(() => expect(focused()).toBe("/b"));
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("focuses an agent tab's workspace", async () => {
    await start("/a/one.md");
    vi.setSystemTime(4_000);
    tabs.show(agentTabId("task_b"));

    await vi.waitFor(() => expect(focused()).toBe("/b"));
  });

  it("lines focus up with the tab in front once the open set is restored", async () => {
    vi.setSystemTime(4_000);
    await start("/b/two.md");

    await vi.waitFor(() => expect(focused()).toBe("/b"));
  });

  it("leaves focus alone for a tab of the focused workspace, or of none", async () => {
    await start("/a/one.md");
    tabs.show("/a/other.md");
    tabs.show(RELEASE_NOTES_TAB_ID);
    tabs.show("/elsewhere/three.md");
    tabs.show(agentTabId("task_gone"));
    tabs.show(null);

    await Promise.resolve();
    expect(focus).not.toHaveBeenCalled();
    expect(focused()).toBe("/a");
  });

  it("keeps a workspace chosen in the rail until another tab is chosen", async () => {
    await start("/a/one.md");
    vi.setSystemTime(4_000);
    await registry.recordFocus("/b");
    // A layout change that leaves the same tab in front.
    tabs.show("/a/one.md");
    await Promise.resolve();
    expect(focused()).toBe("/b");

    vi.setSystemTime(5_000);
    tabs.show("/a/other.md");
    await vi.waitFor(() => expect(focused()).toBe("/a"));
  });
});
