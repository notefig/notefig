import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  disposeTab,
  focusTab,
  grantTabFocusHandoff,
  registerTabController,
  setActiveTab,
  unregisterTabController,
  type TabController,
  type TabFocusOptions,
} from "./tab-controllers";
import { DEFAULT_COOLDOWN_MS as ARBITER_COOLDOWN_MS } from "@/utils/focus-arbiter";

/**
 * A tab whose focus records whether the claim came with a hand-off: a
 * live text entry elsewhere refuses ambient claims and yields to a
 * hand-off, the way the editor's controller does.
 */
function controllerFor(
  tabId: string,
  textEntryActive: () => boolean,
  /** The surface is not ready (an editor mid-remount): every claim fails. */
  unready: () => boolean = () => false,
) {
  const claims: boolean[] = [];
  const controller: TabController = {
    tabId,
    kind: "file",
    focus: ({ steal }: TabFocusOptions = {}) => {
      claims.push(Boolean(steal));
      if (unready()) return false;
      if (!steal && textEntryActive()) return false;
      return true;
    },
    dispose: vi.fn(),
    isFocusable: () => true,
    getSelectedText: () => undefined,
    search: async () => [],
    revealMatch: () => false,
    runHistoryAction: () => false,
  } as unknown as TabController;
  return { controller, claims };
}

// One tab id per test: the arbiter remembers what it last settled for a
// target, so reusing an id would let one test's outcome leak into the next.
let tabCounter = 0;
let TAB = "";
let textEntryActive = false;

beforeEach(async () => {
  textEntryActive = false;
  TAB = `/ws/new-${tabCounter++}.md`;
  setActiveTab(TAB);
  await cooldown();
});

/** A landed focus arms the arbiter's cooldown against equal-priority
 *  claims; wait it out so the next claim is judged on its own terms. */
function cooldown(): Promise<void> {
  return new Promise((resolve) =>
    setTimeout(resolve, ARBITER_COOLDOWN_MS + 10),
  );
}

afterEach(() => {
  unregisterTabController(TAB);
  setActiveTab(null);
});

describe("tab focus hand-off", () => {
  it("an ambient claim never takes focus from a live text entry", () => {
    const { controller, claims } = controllerFor(TAB, () => textEntryActive);
    registerTabController(controller);
    textEntryActive = true;

    expect(focusTab(TAB)).toBe(false);
    expect(claims).toEqual([false]);
  });

  it("a granted hand-off lets the next claim win, and is consumed by it", async () => {
    const first = controllerFor(TAB, () => textEntryActive);
    registerTabController(first.controller);
    textEntryActive = true;

    grantTabFocusHandoff(TAB);
    expect(focusTab(TAB)).toBe(true);
    expect(first.claims).toEqual([true]);

    // Consumed: after a remount (not a dispose), the claim is ambient again.
    await cooldown();
    unregisterTabController(TAB);
    const second = controllerFor(TAB, () => textEntryActive);
    registerTabController(second.controller);
    expect(focusTab(TAB)).toBe(false);
    expect(second.claims).toEqual([false]);
  });

  it("a hand-off outlives a claim that could not land", () => {
    let unready = true;
    const { controller, claims } = controllerFor(
      TAB,
      () => textEntryActive,
      () => unready,
    );
    registerTabController(controller);
    textEntryActive = true;

    grantTabFocusHandoff(TAB);
    expect(focusTab(TAB)).toBe(false);
    // The surface is ready now; the hand-off is still there to use.
    unready = false;
    expect(focusTab(TAB)).toBe(true);
    expect(claims).toEqual([true, true]);
  });

  it("a grant dies with its tab", () => {
    const { controller, claims } = controllerFor(TAB, () => textEntryActive);
    registerTabController(controller);
    grantTabFocusHandoff(TAB);
    disposeTab(TAB);

    registerTabController(controllerFor(TAB, () => true).controller);
    textEntryActive = true;
    expect(focusTab(TAB)).toBe(false);
    expect(claims).toEqual([]);
  });
});
