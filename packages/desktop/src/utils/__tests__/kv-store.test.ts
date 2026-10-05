import { beforeEach, describe, expect, it } from "vitest";

/**
 * The KV store over the `db` surface (MET-124).
 *
 * Backed by a real (in-memory) SQLite through the same driver the desktop uses,
 * because the claims worth testing here are storage claims: that a value comes
 * back after the collection is torn down, and that the imperative helpers and
 * the collection `useKv` reads are the same thing.
 */

import { createCollection } from "@tanstack/react-db";
import { persistedCollectionOptions } from "@tanstack/db-sqlite-persistence-core";
import { createKv, type KvApi, type KvRow } from "../kv-store";
import { createNodeTestDb, type NodeTestDb } from "@/testing/node-db";

const NS = "settings";

let db: NodeTestDb;
let kv: KvApi;

beforeEach(() => {
  db = createNodeTestDb();
  kv = createKv(() => db.get());
});

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
      persistence: db.get(),
    }),
  );
  await collection.preload();
  return collection;
}

describe("reading and writing", () => {
  it("round-trips a value", async () => {
    await kv.write(NS, "theme", "dark");
    expect(await kv.read(NS, "theme")).toBe("dark");
  });

  it("overwrites rather than duplicating on a second write", async () => {
    await kv.write(NS, "zoomLevel", 1);
    await kv.write(NS, "zoomLevel", 1.5);

    expect(await kv.read(NS, "zoomLevel")).toBe(1.5);
    expect(kv.collection(NS).size).toBe(1);
  });

  it("reads a missing key as undefined", async () => {
    expect(await kv.read(NS, "never-written")).toBeUndefined();
  });

  it("returns every value in the namespace", async () => {
    await kv.write(NS, "theme", "dark");
    await kv.write(NS, "zoomLevel", 1.25);

    expect(await kv.readAll(NS)).toEqual({ theme: "dark", zoomLevel: 1.25 });
  });

  it("keeps namespaces apart", async () => {
    await kv.write(NS, "shared-key", "settings value");
    await kv.write("recentProjects", "shared-key", "projects value");

    expect(await kv.read(NS, "shared-key")).toBe("settings value");
    expect(await kv.read("recentProjects", "shared-key")).toBe("projects value");
  });

  it("removes a key, and removing a missing one is not an error", async () => {
    await kv.write(NS, "theme", "dark");
    await kv.remove(NS, "theme");
    expect(await kv.read(NS, "theme")).toBeUndefined();

    await expect(kv.remove(NS, "never-written")).resolves.toBeUndefined();
  });

  it("stores structured values without flattening them", async () => {
    const project = { name: "notes", lastOpenedAt: 1712345678 };
    await kv.write("recentProjects", "/home/p/notes", project);

    expect(await kv.read("recentProjects", "/home/p/notes")).toEqual(project);
  });
});

describe("durability", () => {
  it("brings a value back from storage after the collection is torn down", async () => {
    await kv.write(NS, "telemetryInstallId", "install-123");

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
    await kv.write("first-touch-is-a-write", "consent", 1);

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
    await kv.write(NS, "theme", "light");

    expect(kv.collection(NS).get("theme")?.value).toBe("light");
  });

  it("a collection write is visible to an imperative read", async () => {
    const collection = kv.collection(NS);
    await collection.insert({ key: "lastPath", value: "/home/p/notes" })
      .isPersisted.promise;

    expect(await kv.read(NS, "lastPath")).toBe("/home/p/notes");
  });

  it("an imperative delete is visible to the collection", async () => {
    await kv.write(NS, "theme", "dark");
    await kv.remove(NS, "theme");

    expect(kv.collection(NS).get("theme")).toBeUndefined();
  });
});
