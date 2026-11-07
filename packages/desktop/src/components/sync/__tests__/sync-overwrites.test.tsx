import { afterEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { defineModule } from "@notefig/core";
import { CoreProvider } from "@notefig/core/react";
import { createTestCore } from "@/testing/test-core";
import { SyncOverwritesCell } from "@/components/sync/sync-overwrites";
import {
  INITIAL_SYNC_STATE,
  syncCapabilities,
  transition,
  type SyncOverwriteRecord,
  type WorkspaceSync,
} from "@/modules/sync";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const WS = "/ws";
let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
});

/** A workspace's sync with just what the flag reads. */
function fakeSync(shared: boolean) {
  const listeners = new Set<() => void>();
  let records: SyncOverwriteRecord[] = [];
  let state = transition(INITIAL_SYNC_STATE, { type: "enable" });
  if (shared) state = transition(state, { type: "peers", present: true });
  const capabilities = syncCapabilities(state);
  const sync = {
    workspacePath: WS,
    capabilities: () => capabilities,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    overwrites: () => records,
    dismissOverwrite: (id: string) => {
      records = records.filter((record) => record.id !== id);
      listeners.forEach((listener) => listener());
    },
  } as unknown as WorkspaceSync;
  const report = (record: SyncOverwriteRecord) => {
    records = [...records, record];
    listeners.forEach((listener) => listener());
  };
  return { sync, report };
}

const record: SyncOverwriteRecord = {
  id: "overwrite-1",
  path: "/ws/note.md",
  fragments: ["chapter by B"],
  binary: false,
  recoveryRef: "refs/notefig-local/recovery/1",
  commit: "abc",
  at: 0,
};

async function render(shared: boolean) {
  const fake = fakeSync(shared);
  const core = createTestCore({
    modules: [defineModule({ name: "sync", workspace: { create: () => fake.sync } })],
  });
  await core.boot();
  await core.workspace(WS).open();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      createElement(CoreProvider, {
        core,
        children: createElement(SyncOverwritesCell, { workspacePath: WS }),
      }),
    ),
  );
  return fake;
}

describe("the overwritten flag", () => {
  it("shows at the shared level once a merge overwrote something, until dismissed", async () => {
    const fake = await render(true);
    expect(container!.querySelector("[data-testid=sync-overwrites]")).toBeNull();
    act(() => fake.report(record));
    const flag = container!.querySelector("[data-testid=sync-overwrites]");
    expect(flag?.textContent).toBe("1 overwritten");
    act(() => fake.sync.dismissOverwrite(record.id));
    expect(container!.querySelector("[data-testid=sync-overwrites]")).toBeNull();
  });

  it("never shows at solo", async () => {
    const fake = await render(false);
    act(() => fake.report(record));
    expect(container!.querySelector("[data-testid=sync-overwrites]")).toBeNull();
  });
});
