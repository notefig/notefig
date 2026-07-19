import type { RepoStatus } from "@metrists/git";
import { IsomorphicGitService } from "@metrists/git";
import { platformAdapter } from "@/adapters";
import { normalizePath } from "@/utils/fs";
// Circular with ./collections (which imports git-service-store's
// gitQueryKeys via file-sync.ts); safe, same as collections.ts's own
// documented cycle with file-sync.ts — only referenced inside a function
// body below, never at module-eval time.
import { queryClient } from "./collections";

const gitServiceRegistry = new Map<string, IsomorphicGitService>();
const gitInitRegistry = new Map<string, Promise<void>>();

/** Shared TanStack Query keys for git-derived state of a workspace. */
export function gitQueryKeys(workspacePath: string) {
  return {
    status: ["git", workspacePath, "status"] as const,
    checkpoints: ["git", workspacePath, "checkpoints"] as const,
  };
}

export function getOrCreateWorkspaceGitService(
  workspacePath: string,
): IsomorphicGitService {
  const normalizedWorkspacePath = normalizePath(workspacePath);
  let service = gitServiceRegistry.get(normalizedWorkspacePath);

  if (!service) {
    service = new IsomorphicGitService(
      platformAdapter.getGitStorageHost(normalizedWorkspacePath),
    );
    gitServiceRegistry.set(normalizedWorkspacePath, service);
  }

  return service;
}

export async function ensureWorkspaceGitInitialized(
  workspacePath: string,
): Promise<IsomorphicGitService> {
  const normalizedWorkspacePath = normalizePath(workspacePath);
  const service = getOrCreateWorkspaceGitService(normalizedWorkspacePath);

  const inFlight = gitInitRegistry.get(normalizedWorkspacePath);
  if (inFlight) {
    await inFlight;
    return service;
  }

  const initialization = (async () => {
    await service.init({
      repoPath: normalizedWorkspacePath,
      defaultBranch: "main",
    });
  })().finally(() => {
    gitInitRegistry.delete(normalizedWorkspacePath);
  });

  gitInitRegistry.set(normalizedWorkspacePath, initialization);
  await initialization;
  return service;
}

export async function initializeWorkspaceGit(
  workspacePath: string,
): Promise<IsomorphicGitService> {
  return ensureWorkspaceGitInitialized(workspacePath);
}

export function disposeWorkspaceGitService(workspacePath: string): void {
  const normalizedWorkspacePath = normalizePath(workspacePath);
  gitServiceRegistry.delete(normalizedWorkspacePath);
  gitInitRegistry.delete(normalizedWorkspacePath);
}

export function clearWorkspaceGitServices(): void {
  gitServiceRegistry.clear();
  gitInitRegistry.clear();
}

// Read-side of @metrists/workspace's GitStatusHandle — a plain function
// matching GitStatusProvider's shape, reusing the same cached whole-repo
// status query the status bar already reads (so a per-file `.git()` call
// doesn't trigger a fresh statusMatrix walk). Wiring it in
// (registerGitStatusProvider) is centralized in workspace-providers.ts.
export function readRepoStatus(workspacePath: string): RepoStatus | undefined {
  return queryClient.getQueryData<RepoStatus>(gitQueryKeys(workspacePath).status);
}
