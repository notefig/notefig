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
import { QueryClient } from "@tanstack/react-query";
import { platformAdapter, type IPlatformAdapter } from "@/adapters";
import { agentStoreModule } from "@/modules/agents/agent-collections";
import { harnessDiscoveryModule } from "@/modules/agents/harness-discovery";
import { mockAgentModule } from "@/modules/agents/mock-harness";
import { promptRoundObserverModule } from "@/modules/agents/round-observer";
import { tunnelModule } from "@/modules/agents/tunnel/tunnel-module";
import { workspaceAgentsModule } from "@/modules/agents/workspace-agents";
import { treeInlineEditModule } from "@/modules/tree-inline-edit";
import { sharedSessionsModule } from "@/modules/shared-sessions";
import { canOpenFile } from "@/components/editor/polymorphic-editor";
import { treeExpansionModule } from "@/modules/tree-expansion";
import { telemetryModule } from "@/modules/telemetry";
import { documentsModule } from "@/modules/documents";
import { editorsModule } from "@/modules/editors";
import { filesModule } from "@/modules/files";
import { gitModule } from "@/modules/git";
import { layoutModule, type UrlState } from "@/modules/layout";
import { tabsModule } from "@/modules/tabs";
import { promptRoundsModule } from "@/modules/prompt-rounds";
import { recentDocumentsModule } from "@/modules/recent-documents";
import { scratchpadLandingModule } from "@/modules/scratchpads";
import { scratchpadsModule } from "@/modules/scratchpads";
import { seenModule } from "@/modules/seen";
import { turnWritesModule } from "@/modules/turn-writes";
import { workspacesModule } from "@/modules/workspaces";
import { gitWorkerModule } from "@/modules/git-worker";
import { historyModule } from "@/modules/history";
import { kvModule } from "@/modules/kv";
import { projectSettingsModule } from "@/modules/project-settings";
import { lastToolModule, sidebarViewModule } from "@/modules/sidebar-view";
import { workspaceKey } from "@/utils/path";

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
    kvModule,
    seenModule,
    promptRoundsModule,
    turnWritesModule,
    treeInlineEditModule,
    workspacesModule({ restore: restoreWorkspaces }),
    recentDocumentsModule,
    layoutModule,
    tabsModule({ canOpenFile }),
    editorsModule,
    documentsModule,
    projectSettingsModule,
    // What entering a workspace does, besides opening it.
    scratchpadLandingModule,
    sidebarViewModule,
    // Per open workspace: `core.workspace(ws).files`, `.git`…
    filesModule,
    gitModule,
    scratchpadsModule,
    gitWorkerModule,
    historyModule,
    agentStoreModule,
    promptRoundObserverModule,
    mockAgentModule,
    workspaceAgentsModule,
    sharedSessionsModule,
    treeExpansionModule,
    lastToolModule,
  ];
}

/** The desktop shell (Tauri and its web build). */
export function desktopModules(): AnyModule[] {
  return [
    ...runtimeModules({ restoreWorkspaces: true }),
    harnessDiscoveryModule,
    tunnelModule,
    telemetryModule,
  ];
}

/**
 * Build the root's core: the platform adapter and an app-wide query client
 * are its services, handed to every module that names them. `url` is the
 * root's router, seen through `UrlState`. This is the one place the
 * platform adapter is imported.
 */
export function createAppCore(
  modules: readonly AnyModule[],
  { url }: { url: UrlState },
): Core {
  const core = createCore({
    services: {
      platform: platformAdapter,
      queryClient: new QueryClient(),
      url,
    },
    modules,
    workspaceKey,
  });
  return core;
}
