import { afterEach, describe, expect, it, vi } from "vitest";

// One-shot reads only: the live editor accessors and the document-sync
// layer are stubbed so the test exercises the layout-scoping logic alone.
vi.mock("@/components/editor/editor-store", () => ({
  getEditor: vi.fn(() => undefined),
  getMarkdownEditor: vi.fn(() => undefined),
  getSelectedText: vi.fn(() => undefined),
  isEditorFocusable: vi.fn(() => false),
}));
vi.mock("@/components/editor/markdown-codec", () => ({
  createMarkdownCodec: () => ({ serialize: () => "" }),
}));
vi.mock("@/utils/markdown-conversion", () => ({
  getDocumentSync: () => ({ isDirty: () => false }),
}));

import { getWorkspaceEditorContext } from "./editors";

function setLayout(children: string[], selected: string): void {
  const layout = [{ type: "Window", id: "w1", children, selected }];
  window.history.replaceState(
    null,
    "",
    `/?layout=${encodeURIComponent(JSON.stringify(layout))}`,
  );
}

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("getWorkspaceEditorContext", () => {
  it("does not count a sibling-prefixed workspace's tabs as this workspace's", () => {
    // `/ws-backup` shares `/ws` as a string prefix but is a different
    // workspace; only a tree-relative test tells them apart (utils/path.ts).
    setLayout(["/ws/a.md", "/ws-backup/x.md"], "/ws-backup/x.md");

    const context = getWorkspaceEditorContext("/ws");

    expect(context.openFiles.map((file) => file.path)).toEqual(["/ws/a.md"]);
    expect(context.activeFile).toBeNull();
  });

  it("scopes to the workspace and reports its active file", () => {
    setLayout(["/ws/a.md", "/other/b.md"], "/ws/a.md");

    const context = getWorkspaceEditorContext("/ws");

    expect(context.openFiles.map((file) => file.path)).toEqual(["/ws/a.md"]);
    expect(context.activeFile).toBe("/ws/a.md");
    expect(context.openFiles[0]).toMatchObject({ active: true, dirty: false });
  });
});
