import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/adapters", async () => ({
  platformAdapter: {
    db: (await import("@/testing/node-db")).createNodeTestDb(),
  },
}));
vi.mock("@/entities/files", () => ({
  getOrCreateWorkspaceCollections: vi.fn(),
}));
vi.mock("@/entities/workspaces", () => ({
  workspaceOfPath: (path: string) =>
    path.startsWith("/ws/a/") ? "/ws/a" : path.startsWith("/ws/b/") ? "/ws/b" : null,
  useOpenWorkspaces: () => [],
}));

import {
  MAX_RECENT_DOCUMENTS,
  deriveRecentDocuments,
  recentDocumentsCollection,
  touchRecentDocument,
} from "./recent-documents";
import { workspaceKey } from "@/utils/path";

const open = [
  { key: workspaceKey("/ws/a"), path: "/ws/a" },
  { key: workspaceKey("/ws/b"), path: "/ws/b" },
];

describe("recent documents", () => {
  beforeEach(async () => {
    await recentDocumentsCollection.preload();
    const paths = [...recentDocumentsCollection.keys()];
    if (paths.length > 0) {
      await recentDocumentsCollection.delete(paths).isPersisted.promise;
    }
  });

  it("stores a touched document and moves a re-touched one to the front", async () => {
    await touchRecentDocument("/ws/a/one.md", 10);
    await touchRecentDocument("/ws/a/two.md", 20);
    await touchRecentDocument("/ws/a/one.md", 30);
    await touchRecentDocument("/elsewhere/x.md", 40); // not ours: ignored
    const rows = [...recentDocumentsCollection.values()];
    expect(rows.map((r) => r.path).sort()).toEqual(["/ws/a/one.md", "/ws/a/two.md"]);
    const documents = deriveRecentDocuments(rows, open, () => true, 10);
    expect(documents.map((d) => d.path)).toEqual(["/ws/a/one.md", "/ws/a/two.md"]);
  });

  it("prunes storage to the cap, oldest first", async () => {
    for (let i = 0; i < MAX_RECENT_DOCUMENTS + 3; i += 1) {
      await touchRecentDocument(`/ws/b/${i}.md`, i);
    }
    const rows = [...recentDocumentsCollection.values()];
    expect(rows).toHaveLength(MAX_RECENT_DOCUMENTS);
    expect(rows.some((r) => r.path === "/ws/b/0.md")).toBe(false);
    expect(rows.some((r) => r.path === `/ws/b/${MAX_RECENT_DOCUMENTS + 2}.md`)).toBe(true);
  });

  it("only lists rows of open workspaces whose files still exist, and tags scratchpads", () => {
    const rows = [
      { path: "/ws/a/doc.md", workspaceKey: workspaceKey("/ws/a"), lastOpenedAt: 1 },
      { path: "/ws/a/.notefig/scratchpads/pad.md", workspaceKey: workspaceKey("/ws/a"), lastOpenedAt: 3 },
      { path: "/ws/a/gone.md", workspaceKey: workspaceKey("/ws/a"), lastOpenedAt: 4 },
      { path: "/ws/c/closed.md", workspaceKey: workspaceKey("/ws/c"), lastOpenedAt: 5 },
    ];
    const documents = deriveRecentDocuments(
      rows,
      open,
      (_ws, path) => !path.endsWith("gone.md"),
      10,
    );
    expect(documents.map((d) => [d.path, d.isScratchpad])).toEqual([
      ["/ws/a/.notefig/scratchpads/pad.md", true],
      ["/ws/a/doc.md", false],
    ]);
    expect(deriveRecentDocuments(rows, open, () => true, 1)).toHaveLength(1);
  });
});
