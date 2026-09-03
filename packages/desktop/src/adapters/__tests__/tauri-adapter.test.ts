import { describe, expect, it } from "vitest";
import { withMockedTauri } from "@/testing/tauri-mock";
import { createGitStorageHost } from "../git-storage-host";
import { TauriPlatformAdapter } from "../tauri-adapter";

// The adapter is ~800 lines and its full init touches LazyStore / window /
// dialog plugins. The watch methods are stateless invoke wrappers, so we drive
// them on a directly constructed instance (its fields are lazy — no IPC at
// construction) instead of paying for full init. Scope per the ticket:
// primary lifecycle + one invoke failure.

describe("TauriPlatformAdapter watch lifecycle", () => {
  it("sends the right commands + payloads for start-metadata, start-content, stop", async () => {
    const tauri = withMockedTauri({
      start_watching_metadata: () => null,
      start_watching_content: () => null,
      stop_watching: () => null,
    });
    const adapter = new TauriPlatformAdapter();

    await adapter.fs.startWatchingMetadata(["/ws"], "watch-1");
    await adapter.fs.startWatchingContent(["/ws/a.md"], "watch-1");
    await adapter.fs.stopWatching("watch-1");

    expect(tauri.calls("start_watching_metadata")).toEqual([
      {
        paths: ["/ws"],
        watchId: "watch-1",
        ignoreDirectories: null,
        ignoreExtensions: null,
      },
    ]);
    expect(tauri.calls("start_watching_content")).toEqual([
      { paths: ["/ws/a.md"], watchId: "watch-1" },
    ]);
    expect(tauri.calls("stop_watching")).toEqual([{ watchId: "watch-1" }]);
  });

  it("rethrows a start-metadata invoke failure rather than swallowing it", async () => {
    withMockedTauri({
      start_watching_metadata: () => {
        throw new Error("watcher backend unavailable");
      },
    });
    const adapter = new TauriPlatformAdapter();

    await expect(
      adapter.fs.startWatchingMetadata(["/ws"], "watch-2"),
    ).rejects.toThrow(/watcher backend unavailable/);
  });

  it("stopWatching swallows a failure (cleanup races are expected)", async () => {
    withMockedTauri({
      stop_watching: () => {
        throw new Error("no such watcher");
      },
    });
    const adapter = new TauriPlatformAdapter();

    // Must resolve, not reject — stopping an already-gone watcher is routine.
    await expect(adapter.fs.stopWatching("watch-3")).resolves.toBeUndefined();
  });
});

describe("ignore rules plumbing", () => {
  const IGNORE = { directories: ["node_modules"], extensions: ["mp4"] };

  it("forwards ignore lists on readDirectory and startWatchingMetadata", async () => {
    const tauri = withMockedTauri({
      read_directory: () => ({ ok: true, value: [] }),
      start_watching_metadata: () => null,
    });
    const adapter = new TauriPlatformAdapter();

    await adapter.fs.readDirectory("/ws", { recursive: true, ignore: IGNORE });
    await adapter.fs.startWatchingMetadata(["/ws"], "watch-1", {
      ignore: IGNORE,
    });

    expect(tauri.calls("read_directory")).toEqual([
      {
        path: "/ws",
        recursive: true,
        includeFiles: true,
        includeDirectories: true,
        includeHidden: false,
        ignoreDirectories: ["node_modules"],
        ignoreExtensions: ["mp4"],
      },
    ]);
    expect(tauri.calls("start_watching_metadata")).toEqual([
      {
        paths: ["/ws"],
        watchId: "watch-1",
        ignoreDirectories: ["node_modules"],
        ignoreExtensions: ["mp4"],
      },
    ]);
  });

  it("git storage host readDir never opts into ignore filtering", async () => {
    // The regression that matters: git must see the complete tree —
    // .git internals AND dependency dirs — regardless of app ignore rules.
    const tauri = withMockedTauri({
      read_directory: () => ({
        ok: true,
        value: [
          { path: "/ws/.git", type: "directory" as const },
          { path: "/ws/node_modules", type: "directory" as const },
        ],
      }),
    });
    const adapter = new TauriPlatformAdapter();

    const entries = await createGitStorageHost(adapter.fs, "/ws").readDir(
      "/ws",
    );

    expect(tauri.calls("read_directory")).toEqual([
      {
        path: "/ws",
        recursive: false,
        includeFiles: true,
        includeDirectories: true,
        includeHidden: true,
        ignoreDirectories: null,
        ignoreExtensions: null,
      },
    ]);
    expect(entries.map((e) => e.name)).toEqual([".git", "node_modules"]);
  });
});

describe("metadata date revival", () => {
  it("revives the wire's epoch-millis into Date instances", async () => {
    // fs_ops.rs serializes modifiedAt/createdAt as i64 epoch millis; the
    // adapter interface declares Dates. Regression: raw numbers leaking
    // through crashed pickMostRecentScratchpad (`modifiedAt?.getTime`),
    // silently killing empty-entry scratchpad auto-open for any workspace
    // with two or more scratchpads.
    withMockedTauri({
      get_metadata: () => ({
        succeeded: [
          {
            path: "/ws/a.md",
            type: "file",
            size: 3,
            modifiedAt: 1_700_000_000_000,
            createdAt: 1_600_000_000_000,
          },
        ],
        failed: [],
      }),
    });
    const adapter = new TauriPlatformAdapter();

    const result = await adapter.fs.getMetadata(["/ws/a.md"]);

    const entry = result.succeeded[0];
    expect(entry.modifiedAt).toBeInstanceOf(Date);
    expect(entry.modifiedAt.getTime()).toBe(1_700_000_000_000);
    expect(entry.createdAt).toBeInstanceOf(Date);
    expect(entry.createdAt.getTime()).toBe(1_600_000_000_000);
  });
});
