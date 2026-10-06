/**
 * A workspace's metadata watch lives as long as core keeps the workspace
 * open (MET-177): armed when it opens, kept while it is backgrounded,
 * stopped when it closes — owned by the workspace's files, not by a
 * separate registry of watchers.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { createCore, defineModule } from "@notefig/core";
import type { FileSystemSurface } from "@/adapters/platform-adapter.interface";
import { workspaceKey } from "@/utils/path";
import { metadataWatchIdFor } from "@/modules/files/file-sync";
import { filesModule } from "@/modules/files";

const fsMock = {
  readDirectory: vi.fn(async () => ({ ok: true, value: [] })),
  getMetadata: vi.fn(async () => ({ succeeded: [], failed: [] })),
  onFsEvent: vi.fn(() => () => {}),
  startWatchingMetadata: vi.fn(async () => {}),
  startWatchingContent: vi.fn(async () => {}),
  stopWatching: vi.fn(async () => {}),
};

function coreWithFiles(before: ReturnType<typeof defineModule>[] = []) {
  return createCore({
    services: {
      platform: { fs: fsMock as unknown as FileSystemSurface },
      queryClient: new QueryClient(),
    } as never,
    modules: [...before, filesModule],
    workspaceKey,
  });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("a workspace's metadata watch", () => {
  it("arms when core opens the workspace and stops when it closes it", async () => {
    const core = coreWithFiles();
    const id = metadataWatchIdFor("/ws");

    await core.workspace("/ws").open();
    expect(fsMock.startWatchingMetadata).toHaveBeenCalledWith(["/ws"], id, {
      ignore: expect.anything(),
    });
    expect(fsMock.stopWatching).not.toHaveBeenCalled();

    await core.workspace("/ws").close();
    expect(fsMock.stopWatching).toHaveBeenCalledWith(id);
  });

  it("retries a start that failed, and leaves a healthy watch alone", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    fsMock.startWatchingMetadata.mockRejectedValueOnce(new Error("denied"));
    const core = coreWithFiles();
    await core.workspace("/ws").open();
    await settle();

    core.workspace("/ws").files.ensureWatching();
    expect(fsMock.startWatchingMetadata).toHaveBeenCalledTimes(2);

    await settle();
    core.workspace("/ws").files.ensureWatching();
    expect(fsMock.startWatchingMetadata).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });

  it("gets another chance, and the listing a re-walk, whenever the workspace is focused", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    fsMock.startWatchingMetadata.mockRejectedValueOnce(new Error("denied"));
    const core = coreWithFiles();
    core.boot();
    await core.workspace("/ws").open();
    await settle();
    fsMock.readDirectory.mockClear();

    await core.workspace("/ws").focus();

    expect(fsMock.startWatchingMetadata).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(fsMock.readDirectory).toHaveBeenCalled());
    error.mockRestore();
  });

  it("leaves a workspace alone that closed while an earlier focus step ran", async () => {
    // An earlier `focused` handler still waiting (the open-set write) when
    // the workspace closes: the files step after it must not reach for the
    // closed workspace's instance.
    let gate: Promise<void> | null = null;
    let release!: () => void;
    const slowFocus = defineModule({
      name: "slow-focus",
      boot: (_api, ctx) =>
        ctx.hooks.on("workspace:focused", () => gate ?? undefined),
    });
    const core = coreWithFiles([slowFocus]);
    core.boot();
    await core.workspace("/ws").open();
    fsMock.readDirectory.mockClear();

    gate = new Promise<void>((resolve) => (release = resolve));
    const focusing = core.workspace("/ws").focus();
    await settle();
    await core.workspace("/ws").close();
    release();

    await expect(focusing).resolves.toBeUndefined();
    expect(fsMock.readDirectory).not.toHaveBeenCalled();
  });
});
