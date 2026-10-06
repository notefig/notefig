import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";

// Real file collections over an fs handed to them, the real open set and
// agent store, all read through core; everything else the tabs entity
// reaches is stubbed (same set as tabs.test.ts).
const adapter = {
  readDirectory: vi.fn(),
  getMetadata: vi.fn(),
  readFiles: vi.fn(),
};
vi.mock("@/utils/markdown-conversion", () => ({
  flushDocumentSync: vi.fn(),
  whenDocumentSyncClean: vi.fn(async () => {}),
}));
vi.mock("@/tabs/tab-controllers", () => ({
  disposeTab: vi.fn(),
  focusTab: vi.fn(),
  getTabController: vi.fn(),
  getTabSelectedText: vi.fn(),
  isTabFocusable: vi.fn(),
  revealTabMatch: vi.fn(),
  searchTab: vi.fn(),
}));
vi.mock("./editors", () => ({ editor: vi.fn() }));
vi.mock("@/utils/workspace-write-tracker", () => ({
  whenWorkspaceWritesSettled: vi.fn(async () => {}),
}));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import type { Core } from "@notefig/core";
import { CoreProvider } from "@notefig/core/react";
import type { WorkspaceFiles } from "./files";
import { useWorkspaceTabs, type WorkspaceTabsState } from "./tabs";
import { workspacesModule } from "./workspaces";
import { agentStoreModule } from "@/agent/agent-collections";
import { createTestCore } from "@/testing/test-core";
import { filesModuleOf, testWorkspaceFiles } from "@/testing/test-files";

const WS_A = "/ws-join-a";
const WS_B = "/ws-join-b";
let files: WorkspaceFiles[] = [];
let core: Core;
let container: HTMLDivElement | null = null;
let root: Root | null = null;

function Probe({
  openTabs,
  onState,
}: {
  openTabs: string[];
  onState: (state: WorkspaceTabsState) => void;
}) {
  const state = useWorkspaceTabs(openTabs);
  useEffect(() => {
    onState(state);
  });
  return null;
}

/** Render inside the test core, as the app's shell does. */
function withCore(component: typeof Probe, props: Parameters<typeof Probe>[0]) {
  return createElement(CoreProvider, {
    core,
    children: createElement(component, props),
  });
}

async function tick(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(async () => {
  adapter.readDirectory.mockImplementation(async (dir: string) => ({
    ok: true,
    value: [{ path: `${dir}/note.md`, type: "file" }],
  }));
  adapter.getMetadata.mockResolvedValue({ succeeded: [], failed: [] });
  adapter.readFiles.mockImplementation(async (paths: string[]) => ({
    succeeded: paths.map((path) => ({ path, content: "" })),
    failed: [],
  }));
  files = [WS_A, WS_B].map((ws) => testWorkspaceFiles(ws, adapter));
  core = createTestCore({
    modules: [
      filesModuleOf(files),
      workspacesModule({ restore: false }),
      agentStoreModule,
    ],
  });
  core.boot();
  for (const workspace of files) {
    // Opening joins the open set, as the switcher's open does.
    await core.workspace(workspace.workspacePath).open();
    await workspace.collections.metadata.preload();
  }
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  for (const workspace of files) workspace.dispose();
});

describe("useWorkspaceTabs across open workspaces", () => {
  it("a tab from a backgrounded workspace is not stale", async () => {
    let latest: WorkspaceTabsState | undefined;
    const tabs = [`${WS_A}/note.md`, `${WS_B}/note.md`];
    await act(async () => {
      root!.render(
        withCore(Probe, {
          openTabs: tabs,
          onState: (state) => {
            latest = state;
          },
        }),
      );
    });
    for (let i = 0; i < 20 && latest?.staleTabIds.length !== 0; i++) {
      await tick();
    }

    // Both files exist in their own workspaces, so neither tab is stale —
    // the dock is one layout over every open workspace.
    expect(latest?.staleTabIds).toEqual([]);
    expect([...(latest?.fileTabsByWorkspace ?? [])]).toEqual([
      [WS_A, [`${WS_A}/note.md`]],
      [WS_B, [`${WS_B}/note.md`]],
    ]);
  });

  it("a tab whose file is in no open workspace is stale", async () => {
    let latest: WorkspaceTabsState | undefined;
    await act(async () => {
      root!.render(
        withCore(Probe, {
          openTabs: [`${WS_A}/note.md`, `${WS_A}/gone.md`, "/nowhere/x.md"],
          onState: (state) => {
            latest = state;
          },
        }),
      );
    });
    for (let i = 0; i < 20 && latest?.staleTabIds.length !== 2; i++) {
      await tick();
    }

    // A missing file, and a file in no open workspace, are both stale.
    expect(latest?.staleTabIds).toEqual([`${WS_A}/gone.md`, "/nowhere/x.md"]);
  });
});
