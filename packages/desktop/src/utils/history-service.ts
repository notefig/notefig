/**
 * Registry for the per-workspace document-history git repo — a second,
 * Metrists-owned git repo layered over the same worktree as the user's
 * files, gitdir at `<workspace>/.metrists/history`, never interfering with
 * a workspace that's already its own git repo. Mirrors
 * `git-service-store.ts`'s registry convention exactly (lazy per-workspace
 * singleton + in-flight-init dedup map + dispose/clear).
 */
import { IsomorphicGitService } from "@metrists/git";
import { platformAdapter } from "@/adapters";
import {
  normalizePath,
  resolveWorkspacePath,
  type WorkspacePathResolution,
} from "@/utils/fs";
import { matchLooseFile } from "@/entities/files";

/**
 * Resolve a history-tool document path. History only tracks workspace
 * files, so loose files (editable, but outside the root) get a clearer
 * error than the generic containment failure.
 */
export function resolveHistoryDocumentPath(
  workspacePath: string,
  inputPath: string,
): WorkspacePathResolution {
  const resolved = resolveWorkspacePath(workspacePath, inputPath);
  if (!resolved.ok && matchLooseFile(workspacePath, inputPath)) {
    return {
      ok: false,
      error: `"${inputPath}" is a loose file outside the workspace - document history only tracks workspace files`,
    };
  }
  return resolved;
}

const historyServiceRegistry = new Map<string, IsomorphicGitService>();
const historyInitRegistry = new Map<string, Promise<void>>();

export function historyGitDir(workspacePath: string): string {
  return `${normalizePath(workspacePath)}/.metrists/history`;
}

export function getOrCreateWorkspaceHistoryService(
  workspacePath: string,
): IsomorphicGitService {
  const normalizedWorkspacePath = normalizePath(workspacePath);
  let service = historyServiceRegistry.get(normalizedWorkspacePath);

  if (!service) {
    service = new IsomorphicGitService(
      platformAdapter.getGitStorageHost(normalizedWorkspacePath),
    );
    historyServiceRegistry.set(normalizedWorkspacePath, service);
  }

  return service;
}

export async function ensureWorkspaceHistoryInitialized(
  workspacePath: string,
): Promise<IsomorphicGitService> {
  const normalizedWorkspacePath = normalizePath(workspacePath);
  const service = getOrCreateWorkspaceHistoryService(normalizedWorkspacePath);

  const inFlight = historyInitRegistry.get(normalizedWorkspacePath);
  if (inFlight) {
    await inFlight;
    return service;
  }

  const gitDir = historyGitDir(normalizedWorkspacePath);
  const initialization = (async () => {
    await service.init({
      repoPath: normalizedWorkspacePath,
      gitDir,
      defaultBranch: "main",
    });
    // Exclude .metrists/ from the history repo's own worktree scan
    // (spike finding 3) — gitdir-local, not the workspace's own .gitignore.
    const excludePath = `${gitDir}/info/exclude`;
    const existing = await platformAdapter.readFiles([excludePath]);
    const current = existing.succeeded[0]?.content ?? "";
    if (!current.includes(".metrists/")) {
      await platformAdapter.writeFiles([
        { path: excludePath, content: `${current}\n.metrists/\n` },
      ]);
    }
  })().finally(() => {
    historyInitRegistry.delete(normalizedWorkspacePath);
  });

  historyInitRegistry.set(normalizedWorkspacePath, initialization);
  await initialization;
  return service;
}

/**
 * Commit a checkpoint of everything currently dirty in the history repo's
 * worktree. Returns the new commit oid, or null if there was nothing to
 * commit (mirrors `IsomorphicGitService.addAllAndCommit`).
 */
export async function checkpointWorkspaceHistory(
  workspacePath: string,
  message: string,
  author: { name: string; email: string },
): Promise<string | null> {
  const service = await ensureWorkspaceHistoryInitialized(workspacePath);
  const normalizedWorkspacePath = normalizePath(workspacePath);
  return service.addAllAndCommit({
    repoPath: normalizedWorkspacePath,
    gitDir: historyGitDir(normalizedWorkspacePath),
    message,
    author,
  });
}

export function disposeWorkspaceHistoryService(workspacePath: string): void {
  const normalizedWorkspacePath = normalizePath(workspacePath);
  historyServiceRegistry.delete(normalizedWorkspacePath);
  historyInitRegistry.delete(normalizedWorkspacePath);
}

export function clearWorkspaceHistoryServices(): void {
  historyServiceRegistry.clear();
  historyInitRegistry.clear();
}
