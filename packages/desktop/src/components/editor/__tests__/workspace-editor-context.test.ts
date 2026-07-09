import { describe, it, expect, afterEach } from "vitest";
import { getWorkspaceEditorContext } from "@/components/editor/editor-store";
import type { LayoutNode } from "@/components/dockable";

function setLayout(nodes: LayoutNode[]): void {
  const params = new URLSearchParams(window.location.search);
  params.set("layout", JSON.stringify(nodes));
  window.history.pushState({}, "", `?${params.toString()}`);
}

afterEach(() => {
  window.history.pushState({}, "", "/");
});

describe("getWorkspaceEditorContext", () => {
  it("returns empty context when no tabs are open", () => {
    setLayout([]);
    expect(getWorkspaceEditorContext("/ws")).toEqual({
      openFiles: [],
      activeFile: null,
      selection: undefined,
    });
  });

  it("scopes open tabs to the given workspace and marks the active one", () => {
    setLayout([
      {
        type: "Window",
        id: "w1",
        children: ["/ws/a.md", "/ws/b.md", "/other/c.md"],
        selected: "/ws/b.md",
      } as unknown as LayoutNode,
    ]);

    const ctx = getWorkspaceEditorContext("/ws");
    expect(ctx.openFiles.map((f) => f.path)).toEqual(["/ws/a.md", "/ws/b.md"]);
    expect(ctx.activeFile).toBe("/ws/b.md");
    expect(ctx.openFiles.find((f) => f.path === "/ws/b.md")?.active).toBe(true);
    expect(ctx.openFiles.find((f) => f.path === "/ws/a.md")?.active).toBe(false);
  });
});
