/**
 * Two connections to one database file, each with its own driver and
 * coordinator — the app and a CLI run, as the desktop builds them
 * (createCoordinatedPersistence in tauri-db.ts, over node:sqlite).
 *
 * Writes here are sequential: node:sqlite is synchronous, so two connections
 * in one thread cannot hold overlapping write transactions without blocking
 * each other. True concurrency is covered across real processes by the CLI's
 * two-process test; this covers the desktop's construction of it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCollection } from "@tanstack/db";
import { persistedCollectionOptions } from "@tanstack/db-sqlite-persistence-core";
import { agentTasksCollectionIdentity } from "@notefig/shared/persistence";
import type { AgentTaskRow } from "@notefig/shared/agent";
import { createNodeTestDb, type NodeTestDb } from "@/testing/node-db";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function sharedFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "notefig-coordination-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "notefig.db");
}

/** One connection's view: its test db and its tasks collection. */
async function connect(
  path: string,
  options: { coordinated?: boolean } = {},
): Promise<{
  db: NodeTestDb;
  tasks: ReturnType<typeof tasksCollection>;
}> {
  const db = createNodeTestDb({ path, pollIntervalMs: 20, ...options });
  const tasks = tasksCollection(db);
  await tasks.preload();
  // Registered before anything else so it runs after the collection's own.
  cleanups.unshift(() => db.close());
  return { db, tasks };
}

function tasksCollection(db: NodeTestDb) {
  return createCollection(
    persistedCollectionOptions<AgentTaskRow, string>({
      ...agentTasksCollectionIdentity,
      persistence: db.get(),
    }),
  );
}

function task(taskId: string, overrides: Partial<AgentTaskRow> = {}): AgentTaskRow {
  return {
    taskId,
    workspacePath: "/ws",
    title: taskId,
    status: "idle",
    harnessId: "claude-code",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const ids = (collection: { keys(): IterableIterator<string | number> }) =>
  [...collection.keys()].map(String).sort();

describe("two connections sharing one database", () => {
  it("control: without the coordinator, the second writer's rows are silently lost", async () => {
    const path = sharedFile();
    const app = await connect(path, { coordinated: false });
    const cli = await connect(path, { coordinated: false });

    // Both reported durable. Both numbered their write (term 1, seq 1) from
    // their own view, and the library skips a number already on disk.
    await app.tasks.insert(task("from-app")).isPersisted.promise;
    await cli.tasks.insert(task("from-cli")).isPersisted.promise;

    const onDisk = app.db.storedRows("agent-tasks").map((row) => row.key);
    expect(onDisk).toEqual(["from-app"]);
  });

  it("keeps every write and brings both connections to the same rows", async () => {
    const path = sharedFile();
    const app = await connect(path);
    const cli = await connect(path);

    for (let i = 0; i < 10; i++) {
      await app.tasks.insert(task(`app-${i}`)).isPersisted.promise;
      await cli.tasks.insert(task(`cli-${i}`)).isPersisted.promise;
    }
    // Each side changes a row the other wrote.
    await vi.waitFor(() => expect(app.tasks.has("cli-3")).toBe(true));
    await app.tasks.update("cli-3", (draft) => {
      draft.status = "restored";
    }).isPersisted.promise;
    await vi.waitFor(() => expect(cli.tasks.has("app-7")).toBe(true));
    await cli.tasks.delete("app-7").isPersisted.promise;

    const expected = [
      ...Array.from({ length: 10 }, (_, i) => `app-${i}`).filter((id) => id !== "app-7"),
      ...Array.from({ length: 10 }, (_, i) => `cli-${i}`),
    ].sort();

    await vi.waitFor(() => {
      expect(app.db.storedRows("agent-tasks").map((row) => String(row.key)).sort()).toEqual(expected);
      expect(ids(app.tasks)).toEqual(expected);
      expect(ids(cli.tasks)).toEqual(expected);
      expect(app.tasks.get("cli-3")?.status).toBe("restored");
      expect(cli.tasks.get("cli-3")?.status).toBe("restored");
    });
  });

  it("never brings back a row the other connection deleted", async () => {
    // Rule 3 in SharedDbCoordinator: a delivered message applied after a newer
    // write must not carry row values, or it restores the older row.
    const path = sharedFile();
    const app = await connect(path);
    const cli = await connect(path);

    await app.tasks.insert(task("doomed")).isPersisted.promise;
    await vi.waitFor(() => expect(cli.tasks.has("doomed")).toBe(true));

    const reappeared: string[] = [];
    const subscription = app.tasks.subscribeChanges((changes) => {
      for (const change of changes) {
        if (change.type === "insert" && String(change.key) === "doomed") {
          reappeared.push("insert after delete");
        }
      }
    });
    cleanups.unshift(() => subscription.unsubscribe());

    await cli.tasks.delete("doomed").isPersisted.promise;
    await vi.waitFor(() => expect(app.tasks.has("doomed")).toBe(false));

    // More traffic from both sides, so any stale message has every chance to
    // be applied after the delete.
    for (let i = 0; i < 5; i++) {
      await app.tasks.insert(task(`later-app-${i}`)).isPersisted.promise;
      await cli.tasks.insert(task(`later-cli-${i}`)).isPersisted.promise;
    }
    await vi.waitFor(() => {
      expect(app.tasks.has("later-cli-4")).toBe(true);
      expect(cli.tasks.has("later-app-4")).toBe(true);
    });

    expect(app.tasks.has("doomed")).toBe(false);
    expect(cli.tasks.has("doomed")).toBe(false);
    expect(reappeared).toEqual([]);
  });
});
