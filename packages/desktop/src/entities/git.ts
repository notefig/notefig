/**
 * Git entity — one TanStack DB collection per workspace holding everything
 * git-derived, as discriminated rows:
 *
 *   - `repo`       (one row): branch, ahead/behind, initialized flag, and
 *                  errors-as-data (a failed status/log lands on this row
 *                  instead of throwing, so panel state derives from rows)
 *   - `file`       (one per changed path): staged/unstaged/untracked/
 *                  conflicted flags, keyed `file:<absolute path>`
 *   - `checkpoint` (one per commit): oid/hash/message/timestamp, keyed
 *                  `cp:<oid>`; optimistic saves insert a `pending` row
 *
 * One queryFn fetches status + log together — they derive from the same
 * repo walk and were always invalidated together. Only workspace-access
 * errors escape the queryFn (to reach WorkspaceErrorBoundary, same as the
 * file metadata collection).
 */
import { useMemo } from "react";
import { createCollection, useLiveQuery, eq } from "@tanstack/react-db";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { useIsFetching } from "@tanstack/react-query";
import {
  GitError,
  IsomorphicGitService,
  type GitErrorCode,
  type RepoStatus,
} from "@notefig/git";
import { platformAdapter } from "@/adapters";
import { createGitStorageHost } from "@/adapters/git-storage-host";
import { isWorkspaceAccessError } from "@/adapters/platform-adapter.interface";
import { normalizePath } from "@/utils/fs";
import { ensureExcludeLines } from "@/utils/git-exclude";
import { queryClient } from "./query-client";

const gitServiceRegistry = new Map<string, IsomorphicGitService>();
const gitInitRegistry = new Map<string, Promise<void>>();

export function getOrCreateWorkspaceGitService(
  workspacePath: string,
): IsomorphicGitService {
  const normalizedWorkspacePath = normalizePath(workspacePath);
  let service = gitServiceRegistry.get(normalizedWorkspacePath);

  if (!service) {
    service = new IsomorphicGitService(
      createGitStorageHost(
        platformAdapter.fs,
        `${normalizedWorkspacePath}/.git`,
      ),
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
    // Hide the app's ephemeral root from the repo via its gitdir-local
    // exclude, so a repo initialized through the app never shows
    // .metrists/ as untracked. Best-effort: history-service re-ensures
    // this on every checkpoint.
    try {
      await ensureExcludeLines(`${normalizedWorkspacePath}/.git`, [
        ".metrists/",
      ]);
    } catch (error) {
      console.warn(
        `Failed to update the repo's exclude for '${normalizedWorkspacePath}':`,
        error,
      );
    }
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

/** A GitError flattened to data so it can live on a row. */
export interface SerializedGitError {
  code: GitErrorCode | "Unknown";
  message: string;
}

export interface GitRepoRow {
  id: "repo";
  kind: "repo";
  branch: string;
  ahead?: number;
  behind?: number;
  /** false ⇔ status failed with RepoNotFound */
  initialized: boolean;
  statusError?: SerializedGitError;
  logError?: SerializedGitError;
}

export interface GitFileRow {
  id: string; // `file:<absolute path>`
  kind: "file";
  path: string; // absolute
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflicted: boolean;
}

export interface GitCheckpointRow {
  id: string; // `cp:<oid>`
  kind: "checkpoint";
  oid: string;
  hash: string;
  message: string;
  timestamp: number;
}

export type GitRow = GitRepoRow | GitFileRow | GitCheckpointRow;

export const COMMIT_AUTHOR = { name: "Notefig", email: "git@notefig.com" };

// Measured on the metrists monorepo (packed repo, shim harness): log is
// ~3.3ms/commit on the main thread, so 100 cost ~330ms per refetch while
// the panel realistically shows a screenful. The first-open stall on real
// repos is statusMatrix's one-time packfile parse (~20s), not the log —
// moving that off the main thread is tracked separately.
const CHECKPOINT_LOG_DEPTH = 25;

// debug-panel.tsx (the crash fallback — deliberately self-sufficient) peeks
// this key raw with a hand-inlined ["git", basePath]. If this key shape ever
// changes, update debug-panel in the same commit.
function gitQueryKey(workspacePath: string) {
  return ["git", workspacePath] as const;
}

function serializeGitError(error: unknown): SerializedGitError {
  if (error instanceof GitError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: "Unknown",
    message: error instanceof Error ? error.message : String(error),
  };
}

function fileRowId(absolutePath: string): string {
  return `file:${absolutePath}`;
}

function toAbsolute(workspacePath: string, repoRelativePath: string): string {
  return repoRelativePath.startsWith(workspacePath)
    ? repoRelativePath
    : `${workspacePath}/${repoRelativePath}`;
}

function fileRowsFromStatus(
  workspacePath: string,
  status: RepoStatus,
): GitFileRow[] {
  const rows = new Map<string, GitFileRow>();
  const mark = (
    repoRelativePath: string,
    flag: "staged" | "unstaged" | "untracked" | "conflicted",
  ) => {
    const path = toAbsolute(workspacePath, repoRelativePath);
    let row = rows.get(path);
    if (!row) {
      row = {
        id: fileRowId(path),
        kind: "file",
        path,
        staged: false,
        unstaged: false,
        untracked: false,
        conflicted: false,
      };
      rows.set(path, row);
    }
    row[flag] = true;
  };

  for (const change of status.staged) mark(change.path, "staged");
  for (const change of status.unstaged) mark(change.path, "unstaged");
  for (const path of status.untracked) mark(path, "untracked");
  for (const path of status.conflicts) mark(path, "conflicted");
  return [...rows.values()];
}

/** Exported for unit tests; the collection's queryFn. */
export async function fetchGitRows(workspacePath: string): Promise<GitRow[]> {
  const service = getOrCreateWorkspaceGitService(workspacePath);
  const rows: GitRow[] = [];

  let status: RepoStatus | undefined;
  let statusError: SerializedGitError | undefined;
  try {
    status = await service.status({ repoPath: workspacePath });
  } catch (error) {
    // Only workspace-access errors escape (WorkspaceErrorBoundary); every
    // git failure becomes data on the repo row — no component observes a
    // collection-level error state.
    if (isWorkspaceAccessError(error)) throw error;
    statusError = serializeGitError(error);
  }

  const uninitialized = statusError?.code === "RepoNotFound";

  let logError: SerializedGitError | undefined;
  if (!uninitialized) {
    try {
      const entries = await service.log({
        repoPath: workspacePath,
        depth: CHECKPOINT_LOG_DEPTH,
      });
      for (const entry of entries) {
        rows.push({
          id: `cp:${entry.oid}`,
          kind: "checkpoint",
          oid: entry.oid,
          hash: entry.oid.slice(0, 7),
          message: entry.commit.message.split("\n")[0] || "Commit",
          timestamp: entry.commit.committer.timestamp * 1000,
        });
      }
    } catch (error) {
      if (isWorkspaceAccessError(error)) throw error;
      logError = serializeGitError(error);
    }
  }

  if (status) {
    rows.push(...fileRowsFromStatus(workspacePath, status));
  }

  rows.push({
    id: "repo",
    kind: "repo",
    branch: status?.currentBranch ?? "",
    ahead: status?.ahead,
    behind: status?.behind,
    initialized: !uninitialized,
    statusError,
    logError,
  });

  return rows;
}

function createGitCollection(workspacePath: string) {
  return createCollection(
    queryCollectionOptions<GitRow, string>({
      queryKey: gitQueryKey(workspacePath),
      queryClient,
      retry: false,
      staleTime: 2_000,
      queryFn: () => fetchGitRows(workspacePath),
      getKey: (row) => row.id,

      // Deliberately NO mutation handlers: every git write (save/revert/
      // abort/initialize) is a plain async action + refetch. An optimistic
      // insert with a synthetic key that sync never confirms (a "pending"
      // checkpoint row) permanently strands its ghost in derived live
      // queries (observed on @tanstack/db 0.6.1 — covered by the save
      // regression test); the pending entry is UI state in checkpoint-panel
      // instead. @tanstack/db 0.6.7 claims a fix for exactly this shape
      // (sync confirming a different server-generated key); MET-125 tracks
      // whether that lets this workaround retire — note the cancelQueries
      // guard in saveCheckpoint closes a different race and stays either way.
    }),
  );
}

export type GitCollection = ReturnType<typeof createGitCollection>;

const gitCollectionsRegistry = new Map<string, GitCollection>();

export function getOrCreateGitCollection(workspacePath: string): GitCollection {
  const normalized = normalizePath(workspacePath);
  let collection = gitCollectionsRegistry.get(normalized);
  if (!collection) {
    collection = createGitCollection(normalized);
    gitCollectionsRegistry.set(normalized, collection);
  }
  return collection;
}

export function clearGitCollection(workspacePath: string): void {
  const normalized = normalizePath(workspacePath);
  gitCollectionsRegistry.delete(normalized);
  queryClient.removeQueries({ queryKey: gitQueryKey(normalized) });
}

export interface GitSummary {
  initialized: boolean;
  branch: string;
  ahead?: number;
  behind?: number;
  statusError?: SerializedGitError;
  logError?: SerializedGitError;
  /** Any staged/unstaged/untracked/conflicted file. */
  hasChanges: boolean;
}

/** The workspace's git collection as a render-stable reference. */
function useGitCollection(workspacePath: string): GitCollection;
function useGitCollection(
  workspacePath: string | undefined,
): GitCollection | undefined;
function useGitCollection(
  workspacePath: string | undefined,
): GitCollection | undefined {
  return useMemo(
    () => (workspacePath ? getOrCreateGitCollection(workspacePath) : undefined),
    [workspacePath],
  );
}

/** The repo summary row + change flag; undefined until the first fetch lands. */
export function useGitSummary(
  workspacePath: string | undefined,
): GitSummary | undefined {
  const collection = useGitCollection(workspacePath);
  const { data = [] } = useLiveQuery(
    (q) => (collection ? q.from({ git: collection }) : undefined),
    [workspacePath],
  );
  return useMemo(() => {
    const repo = (data as GitRow[]).find(
      (row): row is GitRepoRow => row.kind === "repo",
    );
    if (!repo) return undefined;
    return {
      initialized: repo.initialized,
      branch: repo.branch,
      ahead: repo.ahead,
      behind: repo.behind,
      statusError: repo.statusError,
      logError: repo.logError,
      hasChanges: (data as GitRow[]).some((row) => row.kind === "file"),
    };
  }, [data]);
}

/** Checkpoints newest-first. */
export function useGitCheckpoints(workspacePath: string): GitCheckpointRow[] {
  const collection = useGitCollection(workspacePath);
  const { data = [] } = useLiveQuery(
    (q) =>
      q
        .from({ git: collection })
        .where(({ git }) => eq(git.kind, "checkpoint")),
    [workspacePath],
  );
  return useMemo(
    () =>
      (data as GitCheckpointRow[])
        .slice()
        .sort((a, b) => b.timestamp - a.timestamp),
    [data],
  );
}

/** Per-file git flags; undefined when the file has no pending change. */
export function useFileGitState(
  workspacePath: string,
  filePath: string,
): GitFileRow | undefined {
  const collection = useGitCollection(workspacePath);
  const { data = [] } = useLiveQuery(
    (q) =>
      q
        .from({ git: collection })
        .where(({ git }) => eq(git.id, fileRowId(filePath))),
    [workspacePath, filePath],
  );
  return (data as GitFileRow[])[0];
}

/** Whether the workspace's git fetch is in flight (anti-flicker gates). */
export function useGitFetching(workspacePath: string): boolean {
  return (
    useIsFetching({ queryKey: gitQueryKey(workspacePath) }, queryClient) > 0
  );
}

/** Non-reactive per-file read of the same row `useFileGitState` serves. */
export function readFileGitState(
  workspacePath: string,
  filePath: string,
): GitFileRow | undefined {
  const row = getOrCreateGitCollection(workspacePath).get(fileRowId(filePath));
  return row?.kind === "file" ? row : undefined;
}

export type SyncState = "uncommitted" | "unsynced" | "synced";

export function deriveSyncState(summary: GitSummary | undefined): SyncState {
  if (!summary) return "synced";
  if (summary.hasChanges) return "uncommitted";
  if ((summary.ahead ?? 0) > 0) return "unsynced";
  return "synced";
}

/** Refetch the workspace's git rows (status + checkpoints in one pass). */
export async function refetchGit(workspacePath: string): Promise<void> {
  await getOrCreateGitCollection(workspacePath).utils.refetch();
}

/** Debounce-friendly invalidation for file-sync's derived-state pass. */
export function invalidateGit(workspacePath: string): void {
  void queryClient.invalidateQueries({
    queryKey: gitQueryKey(normalizePath(workspacePath)),
  });
}

/**
 * Save a checkpoint: `addAllAndCommit`, then refetch. Plain async action —
 * the caller (checkpoint-panel) renders its own pending entry while this is
 * in flight. Returns the new commit oid, or null when there was nothing to
 * commit.
 */
export async function saveCheckpoint(
  workspacePath: string,
  description?: string,
): Promise<string | null> {
  const normalized = normalizePath(workspacePath);
  const service = getOrCreateWorkspaceGitService(normalized);

  // Cancel any in-flight fetch so a stale pre-commit response can't land
  // after the commit's own refetch (the old code's cancelQueries guard, at
  // the entity level).
  await queryClient.cancelQueries({ queryKey: gitQueryKey(normalized) });

  try {
    return await service.addAllAndCommit({
      repoPath: normalized,
      message: description?.trim() || "Commit",
      author: COMMIT_AUTHOR,
    });
  } finally {
    // Refetch even on failure — a partial add may have changed status.
    await refetchGit(normalized);
  }
}

/**
 * Revert to a checkpoint, committing any local changes first (WIP commit) so
 * nothing is lost. A repo operation, not a row edit — plain async action.
 */
export async function revertToCheckpoint(
  workspacePath: string,
  checkpoint: { oid: string; hash: string },
): Promise<void> {
  const service = getOrCreateWorkspaceGitService(workspacePath);
  const status = await service.status({ repoPath: workspacePath });
  const hasLocalChanges =
    status.staged.length > 0 ||
    status.unstaged.length > 0 ||
    status.untracked.length > 0;

  if (hasLocalChanges) {
    await service.addAllAndCommit({
      repoPath: workspacePath,
      message: `WIP before revert ${checkpoint.hash}`,
      author: COMMIT_AUTHOR,
    });
  }

  try {
    await service.revertCommit({
      repoPath: workspacePath,
      oid: checkpoint.oid,
      message: `Revert ${checkpoint.hash}`,
      author: COMMIT_AUTHOR,
    });
  } finally {
    await refetchGit(workspacePath);
  }
}

export async function abortRevert(workspacePath: string): Promise<void> {
  const service = getOrCreateWorkspaceGitService(workspacePath);
  await service.abortRevert({ repoPath: workspacePath });
  await refetchGit(workspacePath);
}

export async function initializeGit(workspacePath: string): Promise<void> {
  await initializeWorkspaceGit(workspacePath);
  await refetchGit(workspacePath);
}
