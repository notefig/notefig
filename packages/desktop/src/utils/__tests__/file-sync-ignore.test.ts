import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { platformAdapter } from "@/adapters";
import { handleMetadataFileSystemChange } from "../file-sync";
import {
  getOrCreateWorkspaceCollections,
  clearWorkspaceCollections,
} from "@/entities/files";

// The frontend backstop for ignore rules: whatever the platform watchers
// let through (browser adapters have no Rust-side filter), nothing ignored
// may enter the metadata collection via watcher events.

vi.mock("@/adapters", async () => ({
  platformAdapter: {
    db: (await import("@/testing/node-db")).createNodeTestDb(),
    fs: {
      getMetadata: vi.fn(),
      readDirectory: vi.fn(),
      readFiles: vi.fn(),
      writeFiles: vi.fn(),
    },
  },
}));

const getMetadataMock = vi.mocked(platformAdapter.fs.getMetadata);

let testCounter = 0;
let WS = "";

beforeEach(async () => {
  vi.clearAllMocks();
  WS = `/ws-file-sync-ignore-${testCounter++}`;
  vi.mocked(platformAdapter.fs.readDirectory).mockResolvedValue({
    ok: true,
    value: [],
  });
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

  const collections = getOrCreateWorkspaceCollections(WS);
  await collections.metadata.preload();
});

afterEach(() => {
  clearWorkspaceCollections(WS);
});

describe("watcher event backstop", () => {
  it("drops created events for ignored paths without stat-ing them", async () => {
    await handleMetadataFileSystemChange(
      {
        changes: [
          {
            type: "created",
            path: `${WS}/node_modules/pkg/index.js`,
            isDirectory: false,
          },
          { type: "created", path: `${WS}/clip.mp4`, isDirectory: false },
        ],
      },
      WS,
    );

    const { metadata } = getOrCreateWorkspaceCollections(WS);
    expect(metadata.get(`${WS}/node_modules/pkg/index.js`)).toBeUndefined();
    expect(metadata.get(`${WS}/clip.mp4`)).toBeUndefined();
    expect(getMetadataMock).not.toHaveBeenCalled();
  });

  it("still adopts created events for tracked paths", async () => {
    await handleMetadataFileSystemChange(
      {
        changes: [{ type: "created", path: `${WS}/a.md`, isDirectory: false }],
      },
      WS,
    );

    const { metadata } = getOrCreateWorkspaceCollections(WS);
    expect(metadata.get(`${WS}/a.md`)).toMatchObject({ type: "file" });
  });

  it("treats a rename INTO ignored space as a delete of the old path", async () => {
    await handleMetadataFileSystemChange(
      {
        changes: [{ type: "created", path: `${WS}/a.md`, isDirectory: false }],
      },
      WS,
    );

    await handleMetadataFileSystemChange(
      {
        changes: [
          {
            type: "renamed",
            path: `${WS}/node_modules/a.md`,
            oldPath: `${WS}/a.md`,
            isDirectory: false,
          },
        ],
      },
      WS,
    );

    const { metadata } = getOrCreateWorkspaceCollections(WS);
    expect(metadata.get(`${WS}/a.md`)).toBeUndefined();
    expect(metadata.get(`${WS}/node_modules/a.md`)).toBeUndefined();
  });

  it("treats a rename OUT of untracked space as a create at the new path", async () => {
    await handleMetadataFileSystemChange(
      {
        changes: [
          {
            type: "renamed",
            path: `${WS}/rescued.md`,
            oldPath: `${WS}/node_modules/rescued.md`,
            isDirectory: false,
          },
        ],
      },
      WS,
    );

    const { metadata } = getOrCreateWorkspaceCollections(WS);
    expect(metadata.get(`${WS}/rescued.md`)).toMatchObject({ type: "file" });
  });
});
