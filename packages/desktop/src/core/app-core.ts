/**
 * The composition root: the one place the app's core is assembled.
 *
 * There are two roots for this app — `src/main.tsx` (the shell) and
 * `packages/marketing/site/main.tsx` (the same app without the desktop-only
 * surfaces). Each picks its module list here and boots it before render;
 * core orders the modules by their `needs`, so a list reads as "what this
 * root runs", not "in which order".
 */
import { createCore, type AnyModule, type Core } from "@notefig/core";
import type { QueryClient } from "@tanstack/react-query";
import { platformAdapter, type IPlatformAdapter } from "@/adapters";
import { agentTasksModule } from "@/agent/agent-collections";
import { harnessDiscoveryModule } from "@/agent/harness-discovery";
import { tunnelModule } from "@/agent/tunnel/tunnel-module";
import { treeInlineEditModule } from "@/components/editor/file-tree";
import { canOpenFile } from "@/components/editor/polymorphic-editor";
import { layoutModule, type UrlState } from "@/entities/layout";
import { tabsModule } from "@/entities/tabs";
import { promptRoundsModule } from "@/entities/prompt-rounds";
import { queryClient } from "@/entities/query-client";
import { seenModule } from "@/entities/seen";
import { turnWritesModule } from "@/entities/turn-writes";
import { workspaceScopesModule } from "@/entities/workspace-scoped";
import { workspacesModule } from "@/entities/workspaces";
import { workspaceKey } from "@/utils/path";
import { workspaceWatchersModule } from "@/utils/workspace-watchers";
import { installAppCore } from "./current";

declare module "@notefig/core" {
  interface CoreServices {
    platform: IPlatformAdapter;
    queryClient: QueryClient;
  }
}

/** What every root that renders a workspace needs running. */
export function runtimeModules({
  restoreWorkspaces,
}: {
  /**
   * Reopen the workspaces the user left open. The desktop shell wants this;
   * the marketing site always seeds its one fixed root itself.
   */
  restoreWorkspaces: boolean;
}): AnyModule[] {
  return [
    workspaceScopesModule,
    workspaceWatchersModule,
    seenModule,
    promptRoundsModule,
    turnWritesModule,
    treeInlineEditModule,
    workspacesModule({ restore: restoreWorkspaces }),
    layoutModule,
    tabsModule({ canOpenFile }),
  ];
}

/** The desktop shell (Tauri and its web build). */
export function desktopModules(): AnyModule[] {
  return [
    ...runtimeModules({ restoreWorkspaces: true }),
    harnessDiscoveryModule,
    agentTasksModule,
    tunnelModule,
  ];
}

/**
 * Build the root's core and install it for code outside React
 * (`appCore()`). `url` is the root's router, seen through `UrlState`.
 */
export function createAppCore(
  modules: readonly AnyModule[],
  { url }: { url: UrlState },
): Core {
  const core = createCore({
    services: { platform: platformAdapter, queryClient, url },
    modules,
    workspaceKey,
  });
  installAppCore(core);
  return core;
}
