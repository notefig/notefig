import { IsomorphicGitService } from "@metrists/git";
import { platformAdapter } from "@/adapters";
import { normalizePath } from "@/utils/fs";

const gitServiceRegistry = new Map<string, IsomorphicGitService>();
const gitInitRegistry = new Map<string, Promise<void>>();

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
