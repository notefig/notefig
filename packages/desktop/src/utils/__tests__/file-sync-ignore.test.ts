import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { FileSystemSurface } from "@/adapters/platform-adapter.interface";
import { handleMetadataFileSystemChange as applyChange } from "../file-sync";
import { createWorkspaceFiles, type WorkspaceFiles } from "@/entities/files";

// The frontend backstop for ignore rules: whatever the platform watchers
// let through (browser adapters have no Rust-side filter), nothing ignored
// may enter the metadata collection via watcher events.

const getMetadataMock = vi.fn();
const fs = {
  getMetadata: getMetadataMock,
  readDirectory: vi.fn(async () => ({ ok: true, value: [] })),
  readFiles: vi.fn(),
  writeFiles: vi.fn(),
  onFsEvent: () => () => {},
  startWatchingMetadata: async () => {},
  stopWatching: async () => {},
} as unknown as FileSystemSurface;

const WS = "/ws-file-sync-ignore";
let files: WorkspaceFiles;

const handleMetadataFileSystemChange = (
  event: Parameters<typeof applyChange>[2],
) => applyChange(files, fs, event);

beforeEach(async () => {
  vi.clearAllMocks();
  getMetadataMock.mockImplementation(async (paths: string[]) => ({
    succeeded: paths.map((path) => ({
      path,
      type: "file" as const,
      size: 1,
      modifiedAt: new Date(1_700_000_000_000),
      createdAt: new Date(1_700_000_000_000),
    })),
    failed: [],
  }));

  files = createWorkspaceFiles({
    workspacePath: WS,
    fs,
    queryClient: new QueryClient(),
  });
  await files.collections.metadata.preload();
});

afterEach(() => {
  files.dispose();
});

describe("watcher event backstop", () => {
  it("drops created events for ignored paths without stat-ing them", async () => {
    await handleMetadataFileSystemChange({
      watchId: "test-watch",
      changes: [
        {
          type: "created",
          path: `${WS}/node_modules/pkg/index.js`,
          isDirectory: false,
        },
        { type: "created", path: `${WS}/clip.mp4`, isDirectory: false },
      ],
    });

    const { metadata } = files.collections;
    expect(metadata.get(`${WS}/node_modules/pkg/index.js`)).toBeUndefined();
    expect(metadata.get(`${WS}/clip.mp4`)).toBeUndefined();
    expect(getMetadataMock).not.toHaveBeenCalled();
  });

  it("still adopts created events for tracked paths", async () => {
    await handleMetadataFileSystemChange({
      watchId: "test-watch",
      changes: [{ type: "created", path: `${WS}/a.md`, isDirectory: false }],
    });

    const { metadata } = files.collections;
    expect(metadata.get(`${WS}/a.md`)).toMatchObject({ type: "file" });
  });

  it("treats a rename INTO ignored space as a delete of the old path", async () => {
    await handleMetadataFileSystemChange({
      watchId: "test-watch",
      changes: [{ type: "created", path: `${WS}/a.md`, isDirectory: false }],
    });

    await handleMetadataFileSystemChange({
      watchId: "test-watch",
      changes: [
        {
          type: "renamed",
          path: `${WS}/node_modules/a.md`,
          oldPath: `${WS}/a.md`,
          isDirectory: false,
        },
      ],
    });

    const { metadata } = files.collections;
    expect(metadata.get(`${WS}/a.md`)).toBeUndefined();
    expect(metadata.get(`${WS}/node_modules/a.md`)).toBeUndefined();
  });

  it("treats a rename OUT of untracked space as a create at the new path", async () => {
    await handleMetadataFileSystemChange({
      watchId: "test-watch",
      changes: [
        {
          type: "renamed",
          path: `${WS}/rescued.md`,
          oldPath: `${WS}/node_modules/rescued.md`,
          isDirectory: false,
        },
      ],
    });

    const { metadata } = files.collections;
    expect(metadata.get(`${WS}/rescued.md`)).toMatchObject({ type: "file" });
  });
});
