import { describe, expect, it, vi } from "vitest";
import { withMockedTauri, withMockedWindow } from "@/testing/tauri-mock";
import { TauriPlatformAdapter } from "../tauri-adapter";
import type {
  ContentChangeEvent,
  MetadataChangeEvent,
} from "../platform-adapter.interface";

/**
 * Watcher events moved off the general platform bus onto the fs surface
 * (MET-122). Two things have to hold and neither is covered elsewhere:
 *
 *  1. Routing — fs listeners see only watcher events, ui listeners see only
 *     window/OS events. They no longer share a callback shape, so a
 *     misrouted event is a silent staleness bug, not a type error.
 *  2. Lifecycle invariance — the two registries share one native
 *     subscription refcount. Splitting them into independent refcounts would
 *     tear down the Tauri `listen()`s as soon as *either* side emptied,
 *     which is exactly the "identical boot/teardown trace" the refactor
 *     promised not to change.
 */

const metadataPayload: MetadataChangeEvent = {
  changes: [{ type: "created", path: "/ws/new.md", isDirectory: false }],
};

const contentPayload: ContentChangeEvent = {
  changes: [{ path: "/ws/a.md", content: "hi", contentHash: "h" }],
};

/**
 * Teardown is doubly async — `cleanupListeners` awaits each stored unlisten
 * promise and the unlisten call itself rides IPC. Emitting without draining
 * that passes whether or not the subscription was torn down, which would
 * make the refcount assertion below vacuous.
 */
const flushTeardown = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("fs change events on the fs surface", () => {
  it("delivers watcher events to fs listeners", async () => {
    const tauri = withMockedTauri({});
    withMockedWindow();
    const adapter = new TauriPlatformAdapter();
    const onFs = vi.fn();

    adapter.fs.onFsEvent(onFs);
    // listen() itself rides IPC, so let its registration settle first.
    await vi.waitFor(() => expect(onFs).toHaveBeenCalledTimes(0));
    tauri.emit("fs-metadata-changed", metadataPayload);
    tauri.emit("fs-content-changed", contentPayload);

    expect(onFs.mock.calls.map(([event]) => event.type)).toEqual([
      "fs-metadata-changed",
      "fs-content-changed",
    ]);
    expect(onFs.mock.calls[0][0].payload).toEqual(metadataPayload);
  });

  it("does not deliver watcher events to ui listeners, or ui events to fs listeners", async () => {
    const tauri = withMockedTauri({});
    withMockedWindow();
    const adapter = new TauriPlatformAdapter();
    const onFs = vi.fn();
    const onUi = vi.fn();

    adapter.fs.onFsEvent(onFs);
    adapter.ui.addEventListener(onUi);
    await vi.waitFor(() => expect(onUi).toHaveBeenCalledTimes(0));

    tauri.emit("fs-metadata-changed", metadataPayload);
    tauri.emit("zoom-changed", 1.5);

    expect(onFs.mock.calls.map(([e]) => e.type)).toEqual([
      "fs-metadata-changed",
    ]);
    expect(onUi.mock.calls.map(([e]) => e.type)).toEqual(["zoom-changed"]);
  });

  it("keeps the native subscription alive while either registry is non-empty", async () => {
    // Workspace close drops the fs listener (file-sync unmounts) while
    // App.tsx keeps its ui listener, and vice versa on route changes —
    // neither may silence the other.
    const tauri = withMockedTauri({});
    withMockedWindow();
    const adapter = new TauriPlatformAdapter();
    const onFs = vi.fn();
    const onUi = vi.fn();

    const unsubscribeFs = adapter.fs.onFsEvent(onFs);
    const unsubscribeUi = adapter.ui.addEventListener(onUi);
    await vi.waitFor(() => expect(onUi).toHaveBeenCalledTimes(0));

    unsubscribeUi();
    await flushTeardown();
    tauri.emit("fs-metadata-changed", metadataPayload);
    expect(onFs).toHaveBeenCalledTimes(1);

    const onUiAgain = vi.fn();
    adapter.ui.addEventListener(onUiAgain);
    unsubscribeFs();
    await flushTeardown();
    tauri.emit("zoom-changed", 1.5);
    expect(onUiAgain).toHaveBeenCalledTimes(1);
    expect(onFs).toHaveBeenCalledTimes(1);
  });
});
