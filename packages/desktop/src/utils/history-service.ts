/**
 * Registry for the per-workspace document-history git repo — a second,
 * Metrists-owned git repo layered over the same worktree as the user's
 * files, gitdir at `<workspace>/.metrists/.git`, never interfering with a
 * workspace that's already its own git repo: `.metrists/` (the app's
 * ephemeral-files root) is hidden from the user's repo via its
 * `.git/info/exclude`. Mirrors `git-service-store.ts`'s registry convention
 * exactly (lazy per-workspace singleton + in-flight-init dedup map +
 * dispose/clear).
 */
import { IsomorphicGitService } from "@notefig/git";
import { platformAdapter } from "@/adapters";
import { createGitStorageHost } from "@/adapters/git-storage-host";
import { path as pathutil, workspaceKey } from "@/utils/path";
import {
  ensureExcludeLines,
  replaceExcludeLine,
} from "@/utils/git-exclude";

const historyServiceRegistry = new Map<string, IsomorphicGitService>();
const historyInitRegistry = new Map<string, Promise<void>>();

export function historyGitDir(workspacePath: string): string {
  return pathutil.join(pathutil.normalize(workspacePath), ".metrists", ".git");
}

/** Pre-rename location of the history gitdir; only read for migration. */
function legacyHistoryGitDir(workspacePath: string): string {
  return pathutil.join(
    pathutil.normalize(workspacePath),
    ".metrists",
    "history",
  );
}

export function getOrCreateWorkspaceHistoryService(
  workspacePath: string,
): IsomorphicGitService {
  // Registry key vs OS-facing value: the key is workspaceKey (lowercased on
  // Windows so respelled routes share one service); repoPath/gitDir keep the
  // caller's native spelling. Identical strings on posix.
  const registryKey = workspaceKey(workspacePath);
  const nativeWorkspacePath = pathutil.normalize(workspacePath);
  let service = historyServiceRegistry.get(registryKey);

  if (!service) {
    service = new IsomorphicGitService(
      createGitStorageHost(
        platformAdapter.fs,
        historyGitDir(nativeWorkspacePath),
      ),
      {
        repoPath: nativeWorkspacePath,
        gitDir: historyGitDir(nativeWorkspacePath),
      },
    );
    historyServiceRegistry.set(registryKey, service);
  }

  return service;
}

/**
 * Best-effort rename of a legacy `.metrists/history` gitdir to
 * `.metrists/.git`. On any failure the old dir is left untouched and init
 * proceeds with a fresh repo — history is a convenience, never a blocker.
 *
 * The skip-check below trusts a destination HEAD because moveDirectory is
 * all-or-nothing: the browser copy-then-delete implementation rolls back
 * partially written destination files on failure, so a present HEAD means
 * either a completed migration or a legitimately re-initialized fresh
 * repo — never a half-copy masking the intact legacy dir.
 */
async function migrateLegacyHistoryGitDir(
  workspacePath: string,
  gitDir: string,
): Promise<void> {
  try {
    const legacyDir = legacyHistoryGitDir(workspacePath);
    const [newHead, legacyHead] = await platformAdapter.fs.exists([
      `${gitDir}/HEAD`,
      `${legacyDir}/HEAD`,
    ]);
    if (newHead?.exists || !legacyHead?.exists) {
      return;
    }
    const moved = await platformAdapter.fs.moveDirectory(legacyDir, gitDir);
    if (!moved.ok) {
      console.warn(
        `History gitdir migration failed for '${workspacePath}'; re-initializing fresh: ${moved.error.message}`,
      );
    }
  } catch (error) {
    console.warn(
      `History gitdir migration failed for '${workspacePath}'; re-initializing fresh:`,
      error,
    );
  }
}

export async function ensureWorkspaceHistoryInitialized(
  workspacePath: string,
): Promise<IsomorphicGitService> {
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
    await migrateLegacyHistoryGitDir(nativeWorkspacePath, gitDir);
    await service.init({ defaultBranch: "main" });

    // Exclude the app-internal .metrists subtrees (this repo's own gitdir,
    // agent configs, the legacy history dir) and the user's .git/ from the
    // history repo's worktree scan — its storage host walks with
    // includeHidden and no ignore rules. Deliberately NOT the whole
    // `.metrists/`: scratchpads (entities/scratchpads.ts) must be checkpointed,
    // and git cannot re-include inside an excluded directory, so anything
    // new placed directly under .metrists/ gets checkpointed unless listed
    // here. replaceExcludeLine migrates pre-MET-135 excludes in place —
    // this file is app-owned, so the rewrite is safe.
    try {
      await replaceExcludeLine(gitDir, ".metrists/", [
        ".metrists/.git/",
        ".metrists/agent/",
        ".metrists/history/",
        ".git/",
      ]);
    } catch (error) {
      console.warn(
        `Failed to update the history repo's exclude for '${nativeWorkspacePath}':`,
        error,
      );
    }

    // Hide .metrists/ from the user's own repo via its gitdir-local
    // exclude (never the tracked .gitignore). Runs on every ensure call —
    // this block re-executes per checkpoint, so a repo the user inits
    // *after* history exists gets the exclude on the next turn.
    try {
      const userGitDir = pathutil.join(nativeWorkspacePath, ".git");
      const [userGit] = await platformAdapter.fs.exists([userGitDir]);
      if (userGit?.exists && userGit.type === "directory") {
        await ensureExcludeLines(userGitDir, [".metrists/"]);
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
}

export function clearWorkspaceHistoryServices(): void {
  historyServiceRegistry.clear();
  historyInitRegistry.clear();
}
