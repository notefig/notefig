import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type {
  FileSystemSurface,
  FsChangeEvent,
} from "@/adapters/platform-adapter.interface";
import { contentWatchIdFor, metadataWatchIdFor } from "@/modules/files/file-sync";
import { createWorkspaceFiles, type WorkspaceFiles } from "@/modules/files";
import { createHooks } from "@notefig/core";

// MET-177 Stage B: with several workspaces open, fs events must only reach
// the watch that produced them. Historically the payload carried no watch
// id and the listener set was flat, so workspace A ingested workspace B's
// files as loose rows (relativePath: undefined). In-tree scoping of the
// paths themselves (sibling prefixes, boundary-crossing renames) is owned
// by the fs layer — Rust's WATCH_ROOTS tests in file_watcher.rs — not by
// the ingestion handlers here.

const listeners = new Set<(event: unknown) => void>();
const fsMock = {
  getMetadata: vi.fn(),
  readDirectory: vi.fn(),
  readFiles: vi.fn(),
  writeFiles: vi.fn(),
  onFsEvent: vi.fn((listener: (event: unknown) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }),
  startWatchingMetadata: vi.fn(async () => {}),
  startWatchingContent: vi.fn(async (_paths: string[], _id: string) => {}),
  stopWatching: vi.fn(async (_id: string) => {}),
};
const fs = fsMock as unknown as FileSystemSurface;

function emit(event: FsChangeEvent): void {
  for (const listener of listeners) listener(event);
}

/** Flush the handler's async pipeline (stat + insert). */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const WS_A = "/ws-iso-a";
const WS_B = "/ws-iso-b";
let filesA: WorkspaceFiles;
let filesB: WorkspaceFiles;

beforeEach(async () => {
  vi.clearAllMocks();
  listeners.clear();
  fsMock.readDirectory.mockResolvedValue({ ok: true, value: [] });
  fsMock.getMetadata.mockImplementation(async (paths: string[]) => ({
    succeeded: paths.map((path) => ({
      path,
      type: "file" as const,
      size: 1,
      modifiedAt: new Date(1_700_000_000_000),
      createdAt: new Date(1_700_000_000_000),
    })),
    failed: [],
  }));
  // Each workspace's files start their metadata watch when created.
  filesA = createWorkspaceFiles({
    workspacePath: WS_A,
    fs,
    queryClient: new QueryClient(),
    hooks: createHooks(),
  });
  filesB = createWorkspaceFiles({
    workspacePath: WS_B,
    fs,
    queryClient: new QueryClient(),
    hooks: createHooks(),
  });
  await filesA.collections.metadata.preload();
  await filesB.collections.metadata.preload();
});

afterEach(() => {
  filesA.dispose();
  filesB.dispose();
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

    const a = filesA.collections;
    const b = filesB.collections;
    expect(b.metadata.get(`${WS_B}/from-b.md`)).toMatchObject({
      relativePath: "from-b.md",
    });
    // The bug: A used to ingest this as a loose row (relativePath
    // undefined) because the flat listener set had no watch-id routing.
    expect(a.metadata.get(`${WS_B}/from-b.md`)).toBeUndefined();
    expect(a.metadata.size).toBe(0);
  });

  it("disposing a workspace's files detaches its watch listener", async () => {
    filesA.dispose();
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

    expect(filesA.collections.metadata.size).toBe(0);
  });

  it("a content change tagged with the metadata watch id reaches the content pipeline", async () => {
    // The recursive metadata watch emits content changes too (external
    // modify of a non-open file) — those must not be dropped by routing.
    const collections = filesA.collections;
    await collections.content.preload();
    const path = `${WS_A}/open.md`;
    collections.content.utils.writeInsert({
      path,
      content: "old",
      contentHash: "old-hash",
    });
    // The handler treats the event as a trigger and re-reads disk.
    fsMock.readFiles.mockResolvedValue({
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
  const startContent = () => fsMock.startWatchingContent.mock.calls;
  const stops = () => fsMock.stopWatching.mock.calls;

  it("arms one content watch per workspace with open file tabs", () => {
    filesA.watchContent([`${WS_A}/a.md`]);
    filesB.watchContent([`${WS_B}/b.md`, `${WS_B}/c.md`]);

    expect(startContent()).toEqual([
      [[`${WS_A}/a.md`], contentWatchIdFor(WS_A)],
      [[`${WS_B}/b.md`, `${WS_B}/c.md`], contentWatchIdFor(WS_B)],
    ]);
  });

  it("re-issues the watch for the workspace whose open set changed (same id, no stop), stops the one that emptied", async () => {
    filesA.watchContent([`${WS_A}/a.md`]);
    filesB.watchContent([`${WS_B}/b.md`]);
    await settle();
    fsMock.startWatchingContent.mockClear();
    fsMock.stopWatching.mockClear();

    filesA.watchContent([`${WS_A}/a.md`, `${WS_A}/d.md`]);
    filesB.watchContent([]);
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
    fsMock.startWatchingContent.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    filesA.watchContent([`${WS_A}/a.md`]);
    // The dock changes before the host acknowledged the first start.
    filesA.watchContent([`${WS_A}/a.md`, `${WS_A}/d.md`]);
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
    fsMock.startWatchingContent.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveStart = resolve;
        }),
    );
    filesA.watchContent([`${WS_A}/a.md`]);
    filesA.watchContent([]);
    await settle();

    // Not yet: a stop racing ahead of its start would find nothing to
    // remove and leave the registration orphaned once the start landed.
    expect(stops()).toEqual([]);
    resolveStart();
    await settle();
    expect(stops().map(([id]) => id)).toEqual([contentWatchIdFor(WS_A)]);
  });

  it("routes a content event to the workspace whose watch produced it", async () => {
    for (const files of [filesA, filesB]) {
      await files.collections.content.preload();
      files.collections.content.utils.writeInsert({
        path: `${files.workspacePath}/open.md`,
        content: "old",
        contentHash: "old-hash",
      });
      files.watchContent([`${files.workspacePath}/open.md`]);
    }
    fsMock.readFiles.mockResolvedValue({
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

    expect(filesB.collections.content.get(`${WS_B}/open.md`)).toMatchObject({
      content: "new",
    });
    expect(filesA.collections.content.get(`${WS_A}/open.md`)).toMatchObject({
      content: "old",
    });
  });
});
