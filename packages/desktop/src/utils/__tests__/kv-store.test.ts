import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The KV store over the `db` surface (MET-124).
 *
 * Backed by a real (in-memory) SQLite through the same driver the desktop uses,
 * because the claims worth testing here are storage claims: that a value comes
 * back after the collection is torn down, and that the imperative helpers and
 * the collection `useKv` reads are the same thing.
 */

const { dbRef } = vi.hoisted(() => ({
  dbRef: { current: null as null | import("../../testing/node-db").NodeTestDb },
}));

vi.mock("@/adapters", async () => ({
  platformAdapter: {
    db: (dbRef.current = (
      await import("../../testing/node-db")
    ).createNodeTestDb()),
  },
}));

import { createCollection } from "@tanstack/react-db";
import { persistedCollectionOptions } from "@tanstack/db-sqlite-persistence-core";
import {
  getOrCreateKvCollection,
  readAllKv,
  readKv,
  removeKv,
  writeKv,
  type KvRow,
} from "../kv-store";

const NS = "settings";

/**
 * A second collection over the same storage, built exactly as `kv-store` builds
 * its own. It never sees the writes in memory, so anything it reports came back
 * out of SQLite — which is the durability claim.
 */
async function reopen(namespace: string) {
  const collection = createCollection(
    persistedCollectionOptions<KvRow, string>({
      id: `kv:${namespace}`,
      getKey: (item) => item.key,
      persistence: dbRef.current!.get(),
    }),
  );
  await collection.preload();
  return collection;
}

beforeEach(async () => {
  const collection = getOrCreateKvCollection(NS);
  await collection.preload();
  for (const row of collection.toArray) {
    await collection.delete(row.key).isPersisted.promise;
  }
});

describe("reading and writing", () => {
  it("round-trips a value", async () => {
    await writeKv(NS, "theme", "dark");
    expect(await readKv(NS, "theme")).toBe("dark");
  });

  it("overwrites rather than duplicating on a second write", async () => {
    await writeKv(NS, "zoomLevel", 1);
    await writeKv(NS, "zoomLevel", 1.5);

    expect(await readKv(NS, "zoomLevel")).toBe(1.5);
    expect(getOrCreateKvCollection(NS).size).toBe(1);
  });

  it("reads a missing key as undefined", async () => {
    expect(await readKv(NS, "never-written")).toBeUndefined();
  });

  it("returns every value in the namespace", async () => {
    await writeKv(NS, "theme", "dark");
    await writeKv(NS, "zoomLevel", 1.25);

    expect(await readAllKv(NS)).toEqual({ theme: "dark", zoomLevel: 1.25 });
  });

  it("keeps namespaces apart", async () => {
    await writeKv(NS, "shared-key", "settings value");
    await writeKv("recentProjects", "shared-key", "projects value");

    expect(await readKv(NS, "shared-key")).toBe("settings value");
    expect(await readKv("recentProjects", "shared-key")).toBe(
      "projects value",
    );
  });

  it("removes a key, and removing a missing one is not an error", async () => {
    await writeKv(NS, "theme", "dark");
    await removeKv(NS, "theme");
    expect(await readKv(NS, "theme")).toBeUndefined();

    await expect(removeKv(NS, "never-written")).resolves.toBeUndefined();
  });

  it("stores structured values without flattening them", async () => {
    const project = { name: "notes", lastOpenedAt: 1712345678 };
    await writeKv("recentProjects", "/home/p/notes", project);

    expect(await readKv("recentProjects", "/home/p/notes")).toEqual(project);
  });
});

describe("durability", () => {
  it("brings a value back from storage after the collection is torn down", async () => {
    await writeKv(NS, "telemetryInstallId", "install-123");

    const collection = await reopen(NS);

    expect(collection.get("telemetryInstallId")).toMatchObject({
      value: "install-123",
      // An optimistic local row would read `$origin: "local"` — this is what
      // separates a real restore from never having forgotten.
      $origin: "remote",
      $synced: true,
    });
  });

  it("survives a namespace being written before it is ever read", async () => {
    // The telemetry bootstrap writes consent before anything has read the
    // namespace, so the very first touch of the collection is a write.
    await writeKv("first-touch-is-a-write", "consent", 1);

    const collection = await reopen("first-touch-is-a-write");

    expect(collection.get("consent")?.value).toBe(1);
  });
});

describe("the imperative helpers and the collection are one store", () => {
  it("an imperative write is visible to the collection the hook reads", async () => {
    // This is what the cutover fixed: the pre-MET-124 callers wrote straight to
    // the adapter, so `useKv` subscribers did not see it until the next
    // refetch — the reason harness discovery had to write through the
    // collection by hand.
    await writeKv(NS, "theme", "light");

    expect(getOrCreateKvCollection(NS).get("theme")?.value).toBe("light");
  });

  it("a collection write is visible to an imperative read", async () => {
    const collection = getOrCreateKvCollection(NS);
    await collection.insert({ key: "lastPath", value: "/home/p/notes" })
      .isPersisted.promise;

    expect(await readKv(NS, "lastPath")).toBe("/home/p/notes");
  });

  it("an imperative delete is visible to the collection", async () => {
    await writeKv(NS, "theme", "dark");
    await removeKv(NS, "theme");

    expect(getOrCreateKvCollection(NS).get("theme")).toBeUndefined();
  });
});
