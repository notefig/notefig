/**
 * Registry for the per-workspace document-history git repo — a second,
 * app-owned git repo layered over the same worktree as the user's files,
 * gitdir at `<workspace>/.notefig/.git`, never interfering with a workspace
 * that's already its own git repo: `.notefig/` (the app's ephemeral-files
 * root) is hidden from the user's repo via its `.git/info/exclude`. Mirrors
 * `git-service-store.ts`'s registry convention exactly (lazy per-workspace
 * singleton + in-flight-init dedup map + dispose/clear).
 */
import type { GitService } from "@notefig/git";
import { platformAdapter } from "@/adapters";
import {
  clearWorkerGitRepos,
  createWorkerGitService,
  disposeWorkerGitRepo,
} from "@/utils/git-worker-client";
import { path as pathutil, workspaceKey } from "@/utils/path";
import { ensureExcludeLines } from "@/utils/git-exclude";
import { APP_DIR_NAME, SCRATCHPADS_REL_PATH } from "@/utils/app-dir";

const historyServiceRegistry = new Map<string, GitService>();
const historyInitRegistry = new Map<string, Promise<void>>();

export function historyGitDir(workspacePath: string): string {
  return pathutil.join(
    pathutil.normalize(workspacePath),
    APP_DIR_NAME,
    ".git",
  );
}

export function getOrCreateWorkspaceHistoryService(
  workspacePath: string,
): GitService {
  // Registry key vs OS-facing value: the key is workspaceKey (lowercased on
  // Windows so respelled routes share one service); repoPath/gitDir keep the
  // caller's native spelling. Identical strings on posix.
  const registryKey = workspaceKey(workspacePath);
  const nativeWorkspacePath = pathutil.normalize(workspacePath);
  let service = historyServiceRegistry.get(registryKey);

  if (!service) {
    // Worker-backed (with an inline fallback): statusMatrix's worktree
    // hashing and packfile parsing run off the main thread.
    service = createWorkerGitService({
      repoPath: nativeWorkspacePath,
      gitDir: historyGitDir(nativeWorkspacePath),
    });
    historyServiceRegistry.set(registryKey, service);
  }

  return service;
}

/**
 * Excludes for the history repo's own worktree walk: everything under the
 * app dir except the scratchpads folder, plus the user's `.git/`. Its
 * storage host walks with includeHidden and no ignore rules, so this file
 * is the only thing keeping the app's own gitdir and agent state out of
 * checkpoints — while scratchpads (entities/scratchpads.ts) must stay in.
 * The `dir/*` + `!dir/child` shape is the one git idiom that re-includes
 * inside an otherwise-excluded directory; excluding `.notefig/` wholesale
 * would make the negation unreachable.
 */
const HISTORY_EXCLUDE_LINES = [
  `${APP_DIR_NAME}/*`,
  `!${SCRATCHPADS_REL_PATH}`,
  ".git/",
];

export async function ensureWorkspaceHistoryInitialized(
  workspacePath: string,
): Promise<GitService> {
  const registryKey = workspaceKey(workspacePath);
  const nativeWorkspacePath = pathutil.normalize(workspacePath);
  const service = getOrCreateWorkspaceHistoryService(nativeWorkspacePath);

  const inFlight = historyInitRegistry.get(registryKey);
  if (inFlight) {
    await inFlight;
    return service;
  }

  const gitDir = historyGitDir(nativeWorkspacePath);
  const initialization = (async () => {
    await service.init({ defaultBranch: "main" });

    try {
      await ensureExcludeLines(gitDir, HISTORY_EXCLUDE_LINES);
    } catch (error) {
      console.warn(
        `Failed to update the history repo's exclude for '${nativeWorkspacePath}':`,
        error,
      );
    }

    // Hide the whole app dir from the user's own repo via its gitdir-local
    // exclude (never the tracked .gitignore) — scratchpads included; they
    // are the app's, not the project's. Runs on every ensure call — this
    // block re-executes per checkpoint, so a repo the user inits *after*
    // history exists gets the exclude on the next turn.
    try {
      const userGitDir = pathutil.join(nativeWorkspacePath, ".git");
      const [userGit] = await platformAdapter.fs.exists([userGitDir]);
      if (userGit?.exists && userGit.type === "directory") {
        await ensureExcludeLines(userGitDir, [`${APP_DIR_NAME}/`]);
      }
    } catch (error) {
      console.warn(
        `Failed to update the user repo's exclude for '${nativeWorkspacePath}':`,
        error,
      );
    }
  })().finally(() => {
    historyInitRegistry.delete(registryKey);
  });

  historyInitRegistry.set(registryKey, initialization);
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
  return service.addAllAndCommit({
    message,
    author,
  });
}

export function disposeWorkspaceHistoryService(workspacePath: string): void {
  const registryKey = workspaceKey(workspacePath);
  historyServiceRegistry.delete(registryKey);
  historyInitRegistry.delete(registryKey);
  disposeWorkerGitRepo(historyGitDir(pathutil.normalize(workspacePath)));
}

export function clearWorkspaceHistoryServices(): void {
  historyServiceRegistry.clear();
  historyInitRegistry.clear();
  clearWorkerGitRepos();
}
