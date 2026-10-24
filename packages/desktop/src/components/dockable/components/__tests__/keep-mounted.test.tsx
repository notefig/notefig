/**
 * A tab marked keepMounted is hidden, not unmounted, while another tab in
 * its window is selected — so content that is costly to rebuild (an
 * editor's whole document DOM and plugin views) survives a tab switch.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CoreProvider } from "@notefig/core/react";
import { Dockable, type LayoutNode } from "@/components/dockable";
import { MAX_KEPT_TABS } from "../Window";
import { createTestCore } from "@/testing/test-core";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

const mounts: Record<string, number> = {};
const unmounts: Record<string, number> = {};

function Probe({ id }: { id: string }) {
  useEffect(() => {
    mounts[id] = (mounts[id] ?? 0) + 1;
    return () => {
      unmounts[id] = (unmounts[id] ?? 0) + 1;
    };
  }, [id]);
  return <div data-probe={id}>{id}</div>;
}

function layoutSelecting(selected: string): LayoutNode[] {
  return [
    {
      type: "Window",
      id: "window",
      children: ["kept", "other", "plain"],
      selected,
      size: 1,
    } as LayoutNode,
  ];
}

function render(core: ReturnType<typeof createTestCore>, selected: string) {
  act(() => {
    root!.render(
      <CoreProvider core={core}>
        <Dockable.Root layout={layoutSelecting(selected)}>
          <Dockable.Tab id="kept" name="Kept" keepMounted>
            <Probe id="kept" />
          </Dockable.Tab>
          <Dockable.Tab id="other" name="Other" keepMounted>
            <Probe id="other" />
          </Dockable.Tab>
          <Dockable.Tab id="plain" name="Plain">
            <Probe id="plain" />
          </Dockable.Tab>
        </Dockable.Root>
      </CoreProvider>,
    );
  });
}

const probe = (id: string) =>
  container!.querySelector<HTMLElement>(`[data-probe="${id}"]`);

describe("keepMounted tabs", () => {
  it("hides a kept tab on switch instead of remounting it", () => {
    const core = createTestCore();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    for (const key of Object.keys(mounts)) delete mounts[key];
    for (const key of Object.keys(unmounts)) delete unmounts[key];

    render(core, "kept");
    expect(mounts.kept).toBe(1);
    // Kept tabs never shown yet are not mounted early.
    expect(probe("other")).toBeNull();

    render(core, "other");
    render(core, "kept");
    render(core, "other");

    expect(mounts.kept).toBe(1);
    expect(unmounts.kept).toBeUndefined();
    expect(mounts.other).toBe(1);

    const hidden = probe("kept")!.parentElement!;
    expect(hidden.inert).toBe(true);
    expect(hidden.style.visibility).toBe("hidden");
    // Off screen as well, so no IntersectionObserver inside sees it in view.
    expect(hidden.style.transform).toBe("translateX(-200%)");
    expect(probe("other")!.parentElement!.inert).toBe(false);
  });

  it("still unmounts a tab that is not kept", () => {
    const core = createTestCore();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    for (const key of Object.keys(mounts)) delete mounts[key];
    for (const key of Object.keys(unmounts)) delete unmounts[key];

    render(core, "plain");
    render(core, "kept");
    render(core, "plain");

    expect(mounts.plain).toBe(2);
    expect(unmounts.plain).toBe(1);
  });

  it("keeps only the most recently selected tabs mounted", () => {
    const core = createTestCore();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    for (const key of Object.keys(mounts)) delete mounts[key];
    for (const key of Object.keys(unmounts)) delete unmounts[key];
    const ids = Array.from({ length: MAX_KEPT_TABS + 2 }, (_, i) => `t${i}`);
    const show = (selected: string) =>
      act(() => {
        root!.render(
          <CoreProvider core={core}>
            <Dockable.Root
              layout={[
                { type: "Window", id: "window", children: ids, selected, size: 1 } as LayoutNode,
              ]}
            >
              {ids.map((id) => (
                <Dockable.Tab key={id} id={id} name={id} keepMounted>
                  <Probe id={id} />
                </Dockable.Tab>
              ))}
            </Dockable.Root>
          </CoreProvider>,
        );
      });

    for (const id of ids) show(id);

    // The two selected first fell out of the window's kept set.
    expect(unmounts.t0).toBe(1);
    expect(unmounts.t1).toBe(1);
    expect(unmounts.t2).toBeUndefined();
    expect(container.querySelectorAll("[data-probe]")).toHaveLength(MAX_KEPT_TABS);
  });
});
