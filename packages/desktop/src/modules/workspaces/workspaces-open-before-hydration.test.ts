import { describe, it, expect, beforeEach } from "vitest";
import { createCollection } from "@tanstack/react-db";
import { persistedCollectionOptions } from "@tanstack/db-sqlite-persistence-core";
import {
  OPEN_WORKSPACES_COLLECTION_ID,
  workspacesModule,
  type OpenWorkspaceRow,
} from "@/modules/workspaces";
import { createNodeTestDb, type NodeTestDb } from "@/testing/node-db";
import { createTestCore } from "@/testing/test-core";

// Same restart rig as workspaces-restore.test.ts: the previous run's rows
// are on disk before the core under test — and so its registry's
// collection — exists. A collection already hydrated before those rows
// were written would be stale against them, which is the very collision
// under test — but from the rig, not the app.
let db: NodeTestDb;

const openSetOn = (database: NodeTestDb) =>
  createCollection(
    persistedCollectionOptions<OpenWorkspaceRow, string>({
      id: OPEN_WORKSPACES_COLLECTION_ID,
      getKey: (row) => row.key,
      persistence: database.get(),
    }),
  );

beforeEach(async () => {
  db = createNodeTestDb();
  // "Previous run": persist two open workspaces, /ws-b focused last.
  const previousRun = openSetOn(db);
  await previousRun.preload();
  await previousRun.insert({
    key: "/ws-a",
    path: "/ws-a",
    openedAt: 1,
    focusedAt: 1,
  }).isPersisted.promise;
  await previousRun.insert({
    key: "/ws-b",
    path: "/ws-b",
    openedAt: 2,
    focusedAt: 5,
  }).isPersisted.promise;
  await previousRun.cleanup();
});

describe("writes issued before the persisted set has hydrated", () => {
  it("an open issued before hydration is durable: the row survives a restart", async () => {
    const core = createTestCore({
      modules: [workspacesModule],
      platform: { db },
    });
    core.boot();
    // No await of readiness: the caller opens the moment core is up, as
    // the test seam and a native "Open Folder" during boot can.
    await core.workspace("/ws-c").open();

    // "Next run": a fresh collection over the same storage sees only what
    // was really committed.
    const nextRun = openSetOn(db);
    await nextRun.preload();
    expect([...nextRun.values()].map((row) => row.path).sort()).toEqual([
      "/ws-a",
      "/ws-b",
      "/ws-c",
    ]);
    await nextRun.cleanup();
  });
});
