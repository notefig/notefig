import { describe, expect, it } from "vitest";
import { withMockedTauri } from "@/testing/tauri-mock";
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

    await adapter.startWatchingMetadata(["/ws"], "watch-1");
    await adapter.startWatchingContent(["/ws/a.md"], "watch-1");
    await adapter.stopWatching("watch-1");

    expect(tauri.calls("start_watching_metadata")).toEqual([
      { paths: ["/ws"], watchId: "watch-1" },
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
      adapter.startWatchingMetadata(["/ws"], "watch-2"),
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
    await expect(adapter.stopWatching("watch-3")).resolves.toBeUndefined();
  });
});
