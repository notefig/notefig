/**
 * The panel acts on the open workspace's git through core
 * (`core.workspace(ws).git`). Rendered over the real git module and a fake
 * history repo, so a broken lookup or action binding fails here rather
 * than only in the app.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { GitService } from "@notefig/git";
import { createCore, defineModule, type Core } from "@notefig/core";
import { CoreProvider } from "@notefig/core/react";
import { TooltipProvider } from "@notefig/ui/tooltip";
import "@/utils/intl";
import { gitModule } from "@/modules/git";
import { workspaceKey } from "@/utils/path";
import { CheckpointPanel } from "../checkpoint-panel";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const WS = "/ws";
const addAllAndCommit = vi.fn(async () => "feedbeef00");
const service = {
  status: vi.fn(async () => ({
    repoPath: WS,
    currentBranch: "main",
    staged: [],
    unstaged: [],
    untracked: ["notes.md"],
    conflicts: [],
    ahead: 0,
  })),
  log: vi.fn(async () => []),
  addAllAndCommit,
} as unknown as GitService;

let core: Core;
let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
  const queryClient = new QueryClient();
  core = createCore({
    services: { queryClient } as never,
    modules: [
      defineModule({
        name: "history",
        workspace: {
          create: () =>
            ({ service: () => service, ready: async () => service }) as never,
        },
      }),
      gitModule,
    ],
    workspaceKey,
  });
  await core.workspace(WS).open();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(CoreProvider, {
        core,
        children: createElement(QueryClientProvider, {
          client: queryClient,
          children: createElement(TooltipProvider, {
            children: createElement(CheckpointPanel, { workspacePath: WS }),
          }),
        }),
      }),
    );
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  await core.dispose();
});

describe("CheckpointPanel", () => {
  it("commits through the open workspace's git", async () => {
    const commit = await vi.waitFor(() => {
      const button = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Commit"]',
      );
      if (!button || button.disabled) throw new Error("not ready");
      return button;
    });

    await act(async () => {
      commit.click();
    });

    await vi.waitFor(() =>
      expect(addAllAndCommit).toHaveBeenCalledWith(
        expect.objectContaining({ message: "Commit" }),
      ),
    );
  });
});
