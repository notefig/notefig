import { afterEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { defineModule } from "@notefig/core";
import { CoreProvider } from "@notefig/core/react";
import "@/utils/intl";
import { createTestCore } from "@/testing/test-core";
import { INITIAL_SYNC_STATE, type WorkspaceSync } from "@/modules/sync";
import { DeletedElsewhereBar } from "../deleted-elsewhere-bar";

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

it("names who deleted the open file, and restores or closes it", async () => {
  const state = { ...INITIAL_SYNC_STATE, setup: "on" as const, deleted: [{ path: "plans/q3.md", by: "Alice" }] };
  const sync = {
    state: () => state,
    subscribe: () => () => {},
    restoreDeleted: vi.fn(async () => {}),
    discardDeleted: vi.fn(async () => {}),
  } as unknown as WorkspaceSync;
  const core = createTestCore({
    modules: [defineModule({ name: "sync", workspace: { create: () => sync, dispose: () => {} } })],
  });
  await core.boot();
  await core.workspace("/work").open();
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  const show = (path: string) =>
    act(async () =>
      root!.render(createElement(CoreProvider, { core, children: createElement(DeletedElsewhereBar, { workspacePath: "/work", path }) })),
    );

  await show("/work/notes.md");
  expect(host.textContent).toBe("");

  await show("/work/plans/q3.md");
  expect(host.textContent).toContain("Alice deleted this file.");
  const [restore, close] = host.querySelectorAll("button");
  await act(async () => restore.click());
  await act(async () => close.click());
  expect(sync.restoreDeleted).toHaveBeenCalledWith("plans/q3.md");
  expect(sync.discardDeleted).toHaveBeenCalledWith("plans/q3.md");
});
