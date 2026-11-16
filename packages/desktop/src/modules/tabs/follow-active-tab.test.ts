import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceRegistry, mostRecentlyFocused, type WorkspaceRegistry } from "@/modules/workspaces";
import { agentTabId } from "@/modules/tabs/tab-id";
import { RELEASE_NOTES_TAB_ID } from "@/modules/tabs/tab-id";
import { createNodeTestDb } from "@/testing/node-db";
import { followActiveTab } from "./tabs";

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
const rows = new Map([["task_b", { workspacePath: "/b" }], ["task_gone", { workspacePath: "/closed" }]]);
let loaded: () => void;
let isLoaded = false;
/** Agent task rows, none until `loaded()`: a restored agent tab's row can
 *  arrive after the open set. */
const tasks = {
  get: (taskId: string) => (isLoaded ? rows.get(taskId) : undefined),
  preload: () =>
    new Promise<void>((done) => {
      loaded = () => {
        isLoaded = true;
        done();
      };
    }),
};
/** Focus as core does it: a second focus of a workspace whose first is
 *  still under way joins it, and records nothing new. */
const inflight = new Map<string, Promise<void>>();
let release: Promise<void> = Promise.resolve();
const focus = vi.fn((path: string) => {
  const joined = inflight.get(path);
  if (joined) return joined;
  const recorded = registry.recordFocus(path);
  const done = release.then(() => recorded).finally(() => inflight.delete(path));
  inflight.set(path, done);
  return done;
});
const focused = () => mostRecentlyFocused(registry.collection.values())?.path;

async function start(initial: string | null = null) {
  tabs = testTabs(initial);
  stop = followActiveTab(tabs, registry, tasks, focus);
  await registry.whenReady();
  // The open set is restored well before the agent tasks load.
  await new Promise((done) => setTimeout(done, 10));
  loaded();
  await new Promise((done) => setTimeout(done, 0));
}

beforeEach(async () => {
  vi.useFakeTimers({ now: 1_000, toFake: ["Date"] });
  focus.mockClear();
  release = Promise.resolve();
  isLoaded = false;
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

  it("waits for a restored agent tab's task before lining focus up", async () => {
    vi.setSystemTime(4_000);
    await start(agentTabId("task_b"));

    await vi.waitFor(() => expect(focused()).toBe("/b"));
  });

  it("ends on the tab in front when a focus joins one still under way", async () => {
    await start("/a/one.md");
    let finish!: () => void;
    release = new Promise<void>((done) => (finish = done));
    vi.setSystemTime(4_000);
    tabs.show("/b/two.md");
    // Recorded at 4 000, and still under way.
    await vi.waitFor(() => expect(focused()).toBe("/b"));
    vi.setSystemTime(5_000);
    release = Promise.resolve();
    tabs.show("/a/one.md");
    await vi.waitFor(() => expect(focused()).toBe("/a"));
    vi.setSystemTime(6_000);
    // Joins the first focus of /b, whose record (4 000) is older than /a's.
    tabs.show("/b/two.md");
    finish();

    await vi.waitFor(() => expect(focused()).toBe("/b"));
  });
});
