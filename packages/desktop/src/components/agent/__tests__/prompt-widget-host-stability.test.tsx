/**
 * The host is a CONTEXT VALUE, and the widget lists it in effect and callback
 * dependency arrays — so its identity is part of its contract, not an
 * implementation detail.
 *
 * The regression this pins: `usePromptWidgetHost` memoized on `useKv(...)`,
 * which returns a fresh object every render. The host therefore changed on
 * every render, every consumer re-rendered, and the node view's reachability
 * effect re-fired — each run touching the database, whose collection updates
 * re-rendered the boundary and started the next lap. The visible symptom was
 * session timestamps repainting continuously and an unbounded stream of db
 * execute calls.
 *
 * A re-render of the provider must therefore hand back the SAME object.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { PromptWidgetHost } from "@notefig/widgets";

vi.mock("@/adapters", async () => ({
  platformAdapter: {
    fs: {
      createFiles: vi.fn(),
      writeFiles: vi.fn(),
      deleteFiles: vi.fn(),
      getMetadata: vi.fn(async () => ({ succeeded: [], failed: [] })),
      readFiles: vi.fn(),
      readDirectory: vi.fn(async () => ({ ok: true, value: [] })),
    },
    db: (await import("@/testing/node-db")).createNodeTestDb(),
  },
}));

vi.mock("@/utils/file-write-effects", () => ({
  invalidateDerivedState: vi.fn(),
}));

// The tab layout is app state the host only forwards to.
vi.mock("@/components/workspace-tabs-provider", () => ({
  useWorkspaceTabs: () => ({ openFile: () => true, openAgentTab: () => {} }),
}));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

describe("usePromptWidgetHost", () => {
  it("returns the same object across re-renders", async () => {
    const { usePromptWidgetHost } = await import("../prompt-widget-host");
    const seen: PromptWidgetHost[] = [];
    let forceRender: () => void = () => {};

    // A probe that records the host on every render and exposes a way to
    // render again without changing anything else.
    const { useState } = await import("react");
    function HostProbe() {
      const [, setTick] = useState(0);
      forceRender = () => setTick((n) => n + 1);
      seen.push(usePromptWidgetHost());
      return null;
    }

    await act(async () => {
      root!.render(createElement(HostProbe));
    });
    await act(async () => {
      forceRender();
    });
    await act(async () => {
      forceRender();
    });

    expect(seen.length).toBeGreaterThanOrEqual(3);
    // Identity, not deep equality: this is what dependency arrays compare.
    for (const host of seen) expect(host).toBe(seen[0]);
  });
});
