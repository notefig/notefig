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
import { agentStoreModule } from "@/agent/agent-collections";
import { harnessDiscoveryModule } from "@/agent/harness-discovery";
import { mockAgentModule } from "@/agent/mock-harness";
import { promptRoundObserverModule } from "@/agent/round-observer";
import { tunnelModule } from "@/agent/tunnel/tunnel-module";
import { workspaceAgentsModule } from "@/agent/workspace-agents";
import { treeInlineEditModule } from "@/components/editor/file-tree";
import { sharedSessionsModule } from "@/components/agent/blob-session-store";
import { canOpenFile } from "@/components/editor/polymorphic-editor";
import { treeExpansionModule } from "@/components/editor/tree-expansion-memory";
import { telemetryModule } from "@/components/telemetry-bootstrap";
import { documentsModule } from "@/entities/documents";
import { editorsModule } from "@/entities/editors";
import { filesModule } from "@/entities/files";
import { gitModule } from "@/entities/git";
import { layoutModule, type UrlState } from "@/entities/layout";
import { tabsModule } from "@/entities/tabs";
import { promptRoundsModule } from "@/entities/prompt-rounds";
import { recentDocumentsModule } from "@/entities/recent-documents";
import { scratchpadLandingModule } from "@/entities/scratchpad-landing";
import { scratchpadsModule } from "@/entities/scratchpads";
import { seenModule } from "@/entities/seen";
import { turnWritesModule } from "@/entities/turn-writes";
import { workspacesModule } from "@/entities/workspaces";
import { gitWorkerModule } from "@/utils/git-worker-client";
import { historyModule } from "@/utils/history-service";
import { kvModule } from "@/utils/kv-store";
import { projectSettingsModule } from "@/utils/project-settings";
import { lastToolModule, sidebarViewModule } from "@/hooks/sidebar-view";
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
