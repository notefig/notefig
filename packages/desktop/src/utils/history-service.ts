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
import { normalizePath } from "@/utils/fs";
import { ensureExcludeLines } from "@/utils/git-exclude";

const historyServiceRegistry = new Map<string, IsomorphicGitService>();
const historyInitRegistry = new Map<string, Promise<void>>();

export function historyGitDir(workspacePath: string): string {
  return `${normalizePath(workspacePath)}/.metrists/.git`;
}

/** Pre-rename location of the history gitdir; only read for migration. */
function legacyHistoryGitDir(workspacePath: string): string {
  return `${normalizePath(workspacePath)}/.metrists/history`;
}

export function getOrCreateWorkspaceHistoryService(
  workspacePath: string,
): IsomorphicGitService {
  const normalizedWorkspacePath = normalizePath(workspacePath);
  let service = historyServiceRegistry.get(normalizedWorkspacePath);

  if (!service) {
    service = new IsomorphicGitService(
      createGitStorageHost(
        platformAdapter.fs,
        historyGitDir(normalizedWorkspacePath),
      ),
    );
    historyServiceRegistry.set(normalizedWorkspacePath, service);
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
  const normalizedWorkspacePath = normalizePath(workspacePath);
  const service = getOrCreateWorkspaceHistoryService(normalizedWorkspacePath);

  const inFlight = historyInitRegistry.get(normalizedWorkspacePath);
  if (inFlight) {
    await inFlight;
    return service;
  }

  const gitDir = historyGitDir(normalizedWorkspacePath);
  const initialization = (async () => {
    await migrateLegacyHistoryGitDir(normalizedWorkspacePath, gitDir);
    await service.init({
      repoPath: normalizedWorkspacePath,
      gitDir,
      defaultBranch: "main",
    });

    // Exclude .metrists/ (this repo's own gitdir + agent configs) and the
    // user's .git/ from the history repo's worktree scan — its storage host
    // walks with includeHidden and no ignore rules, so without these the
    // scan would descend into both.
    try {
      await ensureExcludeLines(gitDir, [".metrists/", ".git/"]);
    } catch (error) {
      console.warn(
        `Failed to update the history repo's exclude for '${normalizedWorkspacePath}':`,
        error,
      );
    }

    // Hide .metrists/ from the user's own repo via its gitdir-local
    // exclude (never the tracked .gitignore). Runs on every ensure call —
    // this block re-executes per checkpoint, so a repo the user inits
    // *after* history exists gets the exclude on the next turn.
    try {
      const userGitDir = `${normalizedWorkspacePath}/.git`;
      const [userGit] = await platformAdapter.fs.exists([userGitDir]);
      if (userGit?.exists && userGit.type === "directory") {
        await ensureExcludeLines(userGitDir, [".metrists/"]);
      }
    } catch (error) {
      console.warn(
        `Failed to update the user repo's exclude for '${normalizedWorkspacePath}':`,
        error,
      );
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
