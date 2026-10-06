import { describe, it, expect } from "vitest";
import { getWorkspaceEditorContext } from "@/entities/editors";
import { createLayout, type LayoutApi } from "@/entities/layout";
import type { LayoutNode } from "@/components/dockable";
import { memoryUrlState } from "@/testing/test-core";

function layoutOf(nodes: LayoutNode[]): LayoutApi {
  const params = new URLSearchParams();
  params.set("layout", JSON.stringify(nodes));
  return createLayout(memoryUrlState(`?${params.toString()}`));
}

describe("getWorkspaceEditorContext", () => {
  it("returns empty context when no tabs are open", () => {
    expect(getWorkspaceEditorContext(layoutOf([]), "/ws")).toEqual({
      openFiles: [],
      activeFile: null,
      selection: undefined,
    });
  });

  it("scopes open tabs to the given workspace and marks the active one", () => {
    const layout = layoutOf([
      {
        type: "Window",
        id: "w1",
        children: ["/ws/a.md", "/ws/b.md", "/other/c.md"],
        selected: "/ws/b.md",
      } as unknown as LayoutNode,
    ]);

    const ctx = getWorkspaceEditorContext(layout, "/ws");
    expect(ctx.openFiles.map((f) => f.path)).toEqual(["/ws/a.md", "/ws/b.md"]);
    expect(ctx.activeFile).toBe("/ws/b.md");
    expect(ctx.openFiles.find((f) => f.path === "/ws/b.md")?.active).toBe(true);
    expect(ctx.openFiles.find((f) => f.path === "/ws/a.md")?.active).toBe(false);
  });
});
