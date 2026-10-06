import { describe, expect, it, vi } from "vitest";

// One-shot reads only: the live editor accessors and the document-sync
// layer are stubbed so the test exercises the layout-scoping logic alone.
vi.mock("@/utils/markdown-conversion", () => ({
  getDocumentSync: () => ({ isDirty: () => false }),
}));

import { createEditors, getWorkspaceEditorContext } from "./editors";
import { createLayout, type LayoutApi } from "./layout";
import { memoryUrlState } from "@/testing/test-core";

function layoutOf(children: string[], selected: string): LayoutApi {
  const layout = [{ type: "Window", id: "w1", children, selected }];
  return createLayout(
    memoryUrlState(`?layout=${encodeURIComponent(JSON.stringify(layout))}`),
  );
}

describe("getWorkspaceEditorContext", () => {
  it("does not count a sibling-prefixed workspace's tabs as this workspace's", () => {
    // `/ws-backup` shares `/ws` as a string prefix but is a different
    // workspace; only a tree-relative test tells them apart (utils/path.ts).
    const layout = layoutOf(["/ws/a.md", "/ws-backup/x.md"], "/ws-backup/x.md");

    const context = getWorkspaceEditorContext({ editors: createEditors(), layout: layout }, "/ws");

    expect(context.openFiles.map((file) => file.path)).toEqual(["/ws/a.md"]);
    expect(context.activeFile).toBeNull();
  });

  it("scopes to the workspace and reports its active file", () => {
    const layout = layoutOf(["/ws/a.md", "/other/b.md"], "/ws/a.md");

    const context = getWorkspaceEditorContext({ editors: createEditors(), layout: layout }, "/ws");

    expect(context.openFiles.map((file) => file.path)).toEqual(["/ws/a.md"]);
    expect(context.activeFile).toBe("/ws/a.md");
    expect(context.openFiles[0]).toMatchObject({ active: true, dirty: false });
  });
});
