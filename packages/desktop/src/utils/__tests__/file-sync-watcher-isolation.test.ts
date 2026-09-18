import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { platformAdapter } from "@/adapters";
import type { FsChangeEvent } from "@/adapters/platform-adapter.interface";
import {
  contentWatchIdFor,
  metadataWatchIdFor,
  startWorkspaceMetadataWatcher,
  syncContentWatchers,
} from "../file-sync";
import {
  getOrCreateWorkspaceCollections,
  clearWorkspaceCollections,
} from "@/entities/files";

// MET-177 Stage B: with several workspaces open, fs events must only reach
// the watch that produced them. Historically the payload carried no watch
// id and the listener set was flat, so workspace A ingested workspace B's
// files as loose rows (relativePath: undefined). In-tree scoping of the
// paths themselves (sibling prefixes, boundary-crossing renames) is owned
// by the fs layer — Rust's WATCH_ROOTS tests in file_watcher.rs — not by
// the ingestion handlers here.

const bus = vi.hoisted(() => ({
  listeners: new Set<(event: unknown) => void>(),
}));

vi.mock("@/adapters", async () => ({
  platformAdapter: {
    db: (await import("@/testing/node-db")).createNodeTestDb(),
    fs: {
      getMetadata: vi.fn(),
      readDirectory: vi.fn(),
      readFiles: vi.fn(),
      writeFiles: vi.fn(),
      onFsEvent: vi.fn((listener: (event: unknown) => void) => {
        bus.listeners.add(listener);
        return () => bus.listeners.delete(listener);
      }),
      startWatchingMetadata: vi.fn(async () => {}),
      startWatchingContent: vi.fn(async () => {}),
      stopWatching: vi.fn(async () => {}),
    },
  },
}));

function emit(event: FsChangeEvent): void {
  for (const listener of bus.listeners) listener(event);
}

/** Flush the handler's async pipeline (stat + insert). */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

let testCounter = 0;
let WS_A = "";
let WS_B = "";
let watcherA: ReturnType<typeof startWorkspaceMetadataWatcher> | undefined;
let watcherB: ReturnType<typeof startWorkspaceMetadataWatcher> | undefined;

beforeEach(async () => {
  vi.clearAllMocks();
  bus.listeners.clear();
  const n = testCounter++;
  WS_A = `/ws-iso-a-${n}`;
  WS_B = `/ws-iso-b-${n}`;
  vi.mocked(platformAdapter.fs.readDirectory).mockResolvedValue({
    ok: true,
    value: [],
  });
  vi.mocked(platformAdapter.fs.getMetadata).mockImplementation(
    async (paths: string[]) => ({
      succeeded: paths.map((path) => ({
        path,
        type: "file" as const,
        size: 1,
        modifiedAt: new Date(1_700_000_000_000),
        createdAt: new Date(1_700_000_000_000),
      })),
      failed: [],
    }),
  );
  for (const ws of [WS_A, WS_B]) {
    const collections = getOrCreateWorkspaceCollections(ws);
    await collections.metadata.preload();
  }
  watcherA = startWorkspaceMetadataWatcher(WS_A);
  watcherB = startWorkspaceMetadataWatcher(WS_B);
});

afterEach(() => {
  syncContentWatchers(new Map());
  watcherA?.stop();
  watcherB?.stop();
  clearWorkspaceCollections(WS_A);
  clearWorkspaceCollections(WS_B);
});

describe("watcher event isolation across open workspaces", () => {
  it("a created event for workspace B never lands in workspace A", async () => {
    emit({
      type: "fs-metadata-changed",
      payload: {
        watchId: metadataWatchIdFor(WS_B),
        changes: [
          { type: "created", path: `${WS_B}/from-b.md`, isDirectory: false },
        ],
      },
    });
    await settle();

    const a = getOrCreateWorkspaceCollections(WS_A);
    const b = getOrCreateWorkspaceCollections(WS_B);
    expect(b.metadata.get(`${WS_B}/from-b.md`)).toMatchObject({
      relativePath: "from-b.md",
    });
    // The bug: A used to ingest this as a loose row (relativePath
    // undefined) because the flat listener set had no watch-id routing.
    expect(a.metadata.get(`${WS_B}/from-b.md`)).toBeUndefined();
    expect(a.metadata.size).toBe(0);
  });

  it("stopping a watcher detaches its listener", async () => {
    watcherA?.stop();
    watcherA = undefined;
    emit({
      type: "fs-metadata-changed",
      payload: {
        watchId: metadataWatchIdFor(WS_A),
        changes: [
          { type: "created", path: `${WS_A}/late.md`, isDirectory: false },
        ],
      },
    });
    await settle();

    const a = getOrCreateWorkspaceCollections(WS_A);
    expect(a.metadata.size).toBe(0);
  });

  it("a content change tagged with the metadata watch id reaches the content pipeline", async () => {
    // The recursive metadata watch emits content changes too (external
    // modify of a non-open file) — those must not be dropped by routing.
    const collections = getOrCreateWorkspaceCollections(WS_A);
    await collections.content.preload();
    const path = `${WS_A}/open.md`;
    collections.content.utils.writeInsert({
      path,
      content: "old",
      contentHash: "old-hash",
    });
    // The handler treats the event as a trigger and re-reads disk.
    vi.mocked(platformAdapter.fs.readFiles).mockResolvedValue({
      succeeded: [{ path, content: "new" }],
      failed: [],
    });

    emit({
      type: "fs-content-changed",
      payload: {
        watchId: metadataWatchIdFor(WS_A),
        changes: [{ path, content: "new", contentHash: "new-hash" }],
      },
    });
    await settle();

    expect(collections.content.get(path)).toMatchObject({
      content: "new",
    });
  });
});

describe("content watchers across open workspaces", () => {
  const startContent = () =>
    vi.mocked(platformAdapter.fs.startWatchingContent).mock.calls;
  const stops = () => vi.mocked(platformAdapter.fs.stopWatching).mock.calls;

  it("arms one content watch per workspace with open file tabs", () => {
    syncContentWatchers(
      new Map([
        [WS_A, [`${WS_A}/a.md`]],
        [WS_B, [`${WS_B}/b.md`, `${WS_B}/c.md`]],
      ]),
    );

    expect(startContent()).toEqual([
      [[`${WS_A}/a.md`], contentWatchIdFor(WS_A)],
      [[`${WS_B}/b.md`, `${WS_B}/c.md`], contentWatchIdFor(WS_B)],
    ]);
  });

  it("re-issues the watch for the workspace whose open set changed (same id, no stop), stops the one that emptied", async () => {
    syncContentWatchers(
      new Map([
        [WS_A, [`${WS_A}/a.md`]],
        [WS_B, [`${WS_B}/b.md`]],
      ]),
    );
    await settle();
    vi.mocked(platformAdapter.fs.startWatchingContent).mockClear();
    vi.mocked(platformAdapter.fs.stopWatching).mockClear();

    syncContentWatchers(
      new Map([[WS_A, [`${WS_A}/a.md`, `${WS_A}/d.md`]]]),
    );
    await settle();

    // A's path set changed: the backend reconciles the delta on the live
    // id, so the registration and its listener are never torn down.
    expect(stops().map(([id]) => id)).toEqual([contentWatchIdFor(WS_B)]);
    expect(startContent()).toEqual([
      [[`${WS_A}/a.md`, `${WS_A}/d.md`], contentWatchIdFor(WS_A)],
    ]);
  });

  it("serializes a re-issue behind an in-flight start, and never stops a still-wanted watch", async () => {
    let resolveFirst!: () => void;
    vi.mocked(platformAdapter.fs.startWatchingContent).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    syncContentWatchers(new Map([[WS_A, [`${WS_A}/a.md`]]]));
    // The dock changes before the host acknowledged the first start.
    syncContentWatchers(new Map([[WS_A, [`${WS_A}/a.md`, `${WS_A}/d.md`]]]));
    await settle();

    // The second start waits for the first: the last set issued is the
    // last to take effect at the host, whatever its task scheduling.
    expect(startContent()).toHaveLength(1);
    resolveFirst();
    await settle();
    expect(startContent()).toEqual([
      [[`${WS_A}/a.md`], contentWatchIdFor(WS_A)],
      [[`${WS_A}/a.md`, `${WS_A}/d.md`], contentWatchIdFor(WS_A)],
    ]);
    expect(stops()).toEqual([]);
  });

  it("a stop that lands while the start is in flight is issued after it, exactly once", async () => {
    let resolveStart!: () => void;
    vi.mocked(platformAdapter.fs.startWatchingContent).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveStart = resolve;
        }),
    );
    syncContentWatchers(new Map([[WS_A, [`${WS_A}/a.md`]]]));
    syncContentWatchers(new Map());
    await settle();

    // Not yet: a stop racing ahead of its start would find nothing to
    // remove and leave the registration orphaned once the start landed.
    expect(stops()).toEqual([]);
    resolveStart();
    await settle();
    expect(stops().map(([id]) => id)).toEqual([contentWatchIdFor(WS_A)]);
  });

  it("routes a content event to the workspace whose watch produced it", async () => {
    for (const ws of [WS_A, WS_B]) {
      const collections = getOrCreateWorkspaceCollections(ws);
      await collections.content.preload();
      collections.content.utils.writeInsert({
        path: `${ws}/open.md`,
        content: "old",
        contentHash: "old-hash",
      });
    }
    syncContentWatchers(
      new Map([
        [WS_A, [`${WS_A}/open.md`]],
        [WS_B, [`${WS_B}/open.md`]],
      ]),
    );
    vi.mocked(platformAdapter.fs.readFiles).mockResolvedValue({
      succeeded: [{ path: `${WS_B}/open.md`, content: "new" }],
      failed: [],
    });

    emit({
      type: "fs-content-changed",
      payload: {
        watchId: contentWatchIdFor(WS_B),
        changes: [
          { path: `${WS_B}/open.md`, content: "new", contentHash: "new-hash" },
        ],
      },
    });
    await settle();

    expect(
      getOrCreateWorkspaceCollections(WS_B).content.get(`${WS_B}/open.md`),
    ).toMatchObject({ content: "new" });
    expect(
      getOrCreateWorkspaceCollections(WS_A).content.get(`${WS_A}/open.md`),
    ).toMatchObject({ content: "old" });
  });
});
