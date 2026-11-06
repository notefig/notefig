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
import { platformAdapter } from "@/adapters";
import { agentStoreModule } from "@/modules/agents/agent-collections";
import { agentDirectivesModule } from "@/modules/agents/agent-directives";
import { harnessProbeModule } from "@/modules/agents/harness-probe";
import { mockAgentModule } from "@/modules/agents/mock-harness";
import { tunnelModule } from "@/modules/agents/tunnel/tunnel-module";
import { workspaceAgentsModule } from "@/modules/agents/workspace-agents";
import { treeInlineEditModule } from "@/modules/tree-inline-edit";
import { sharedSessionsModule } from "@/modules/shared-sessions";
import { treeExpansionModule } from "@/modules/tree-expansion";
import { treeModelModule } from "@/modules/tree-model";
import { telemetryModule } from "@/modules/telemetry";
import { dictationModule } from "@/modules/dictation";
import { diffBlocksModule } from "@/modules/diff-blocks";
import { documentsModule } from "@/modules/documents";
import { editorsModule } from "@/modules/editors";
import { filesModule } from "@/modules/files";
import { gitModule } from "@/modules/git";
import { layoutModule, type UrlState } from "@/modules/layout";
import { tabsModule } from "@/modules/tabs";
import { promptRoundsModule } from "@/modules/prompt-rounds";
import { promptWidgetsModule } from "@/modules/prompt-widgets";
import { recentDocumentsModule } from "@/modules/recent-documents";
import { scratchpadLandingModule } from "@/modules/scratchpads";
import { scratchpadsModule } from "@/modules/scratchpads";
import { seenModule } from "@/modules/seen";
import { sessionModule } from "@/modules/session";
import { usageModule } from "@/modules/usage";
import { feedbackModule } from "@/modules/feedback";
import { turnWritesModule } from "@/modules/turn-writes";
import {
  restoreWorkspacesModule,
  workspacesModule,
} from "@/modules/workspaces";
import { gitWorkerModule } from "@/modules/git-worker";
import { historyModule } from "@/modules/history";
import { kvModule } from "@/modules/kv";
import { projectSettingsModule } from "@/modules/project-settings";
import { lastToolModule, sidebarViewModule } from "@/modules/sidebar-view";
import { workspaceKey } from "@/utils/path";

/** What every root that renders a workspace needs running. */
export function runtimeModules(): AnyModule[] {
  return [
    kvModule,
    seenModule,
    promptRoundsModule,
    turnWritesModule,
    treeInlineEditModule,
    workspacesModule,
    recentDocumentsModule,
    layoutModule,
    tabsModule,
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
    // `@model:` and `@skill:` in the composers (`core.directives`).
    agentDirectivesModule,
    // Every prompt widget's state (`core.promptWidgets`).
    promptWidgetsModule,
    // Diff fences in rendered markdown draw as diffs.
    diffBlocksModule,
    mockAgentModule,
    workspaceAgentsModule,
    sharedSessionsModule,
    usageModule,
    treeExpansionModule,
    treeModelModule,
    lastToolModule,
    // "Send Feedback": `available` only in builds given a support URL.
    feedbackModule,
  ];
}

/** The desktop shell (Tauri and its web build). */
export function desktopModules(): AnyModule[] {
  return [
    ...runtimeModules(),
    // Reopen the workspaces the user left open; the marketing site seeds
    // its one fixed root instead.
    restoreWorkspacesModule,
    // Restores the last session's layout on a cold boot, records it after.
    sessionModule,
    // Finds what each harness offers before a session does; never in a
    // browser or mock mode, which have no harness to spawn.
    harnessProbeModule,
    tunnelModule,
    telemetryModule,
    // Push-to-talk into the editors, on the bundled model. The model ships
    // with this build only, so the marketing site leaves it out.
    dictationModule,
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
