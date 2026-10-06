import { describe, it, expect, beforeEach } from "vitest";

import {
  MAX_RECENT_DOCUMENTS,
  createRecentDocuments,
  deriveRecentDocuments,
  type RecentDocumentsApi,
} from "@/modules/recent-documents";
import { createNodeTestDb } from "@/testing/node-db";
import { workspaceKey } from "@/utils/path";

/** The open workspaces' containment, as the registry answers it. */
const workspaceOf = (path: string) =>
  path.startsWith("/ws/a/") ? "/ws/a" : path.startsWith("/ws/b/") ? "/ws/b" : null;

const open = [
  { key: workspaceKey("/ws/a"), path: "/ws/a" },
  { key: workspaceKey("/ws/b"), path: "/ws/b" },
];

describe("recent documents", () => {
  let recent: RecentDocumentsApi;

  beforeEach(() => {
    recent = createRecentDocuments({
      persistence: createNodeTestDb().get(),
      workspaceOf,
    });
  });

  it("stores a touched document and moves a re-touched one to the front", async () => {
    await recent.touch("/ws/a/one.md", 10);
    await recent.touch("/ws/a/two.md", 20);
    await recent.touch("/ws/a/one.md", 30);
    await recent.touch("/elsewhere/x.md", 40); // not ours: ignored
    const rows = [...recent.collection.values()];
    expect(rows.map((r) => r.path).sort()).toEqual(["/ws/a/one.md", "/ws/a/two.md"]);
    const documents = deriveRecentDocuments(rows, open, () => true, 10);
    expect(documents.map((d) => d.path)).toEqual(["/ws/a/one.md", "/ws/a/two.md"]);
  });

  it("prunes storage to the cap, oldest first", async () => {
    for (let i = 0; i < MAX_RECENT_DOCUMENTS + 3; i += 1) {
      await recent.touch(`/ws/b/${i}.md`, i);
    }
    const rows = [...recent.collection.values()];
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
