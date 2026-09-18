import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createCollection } from "@tanstack/react-db";
import { persistedCollectionOptions } from "@tanstack/db-sqlite-persistence-core";

/**
 * A `useKv(...).set` issued before the namespace has hydrated must still be
 * durable. The persistence layer assigns a local stream position from what
 * it has observed so far; before hydration that is the position a previous
 * session already used, and the adapter treats the write as already
 * applied — the row shows in memory and is gone on the next launch.
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
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import { useKv, type KvRow } from "../kv-store";

const NS = "early";
const storage = () =>
  createCollection(
    persistedCollectionOptions<KvRow, string>({
      id: `kv:${NS}`,
      getKey: (row) => row.key,
      persistence: dbRef.current!.get(),
    }),
  );

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let api: ReturnType<typeof useKv<number>> | undefined;

function Probe() {
  api = useKv<number>(NS);
  useEffect(() => {});
  return null;
}

beforeEach(async () => {
  // "Previous session": one row already in storage.
  const previous = storage();
  await previous.preload();
  await previous.insert({ key: "a", value: 1 }).isPersisted.promise;
  await previous.cleanup();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
});

describe("useKv().set before hydration", () => {
  it("is durable: a fresh collection over the same storage sees the row", async () => {
    // A synchronous act: render and effects run, hydration (several
    // storage round-trips) does not get to finish — the window a boot-time
    // write lands in.
    act(() => {
      root!.render(createElement(Probe));
    });
    expect(api!.isReady).toBe(false);
    api!.set("b", 2);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });

    const next = storage();
    await next.preload();
    expect([...next.values()].map((row) => row.key).sort()).toEqual(["a", "b"]);
    await next.cleanup();
  });
});
