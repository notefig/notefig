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
 *
 * Every row derives from the app's HISTORY repo (`<ws>/.notefig/.git`,
 * via modules/history) — never from a `.git` the user may keep in
 * the same workspace. Their repo is theirs alone: the app must not read
 * its status, rewrite its index, or commit into it.
 */
import { defineModule } from "@notefig/core";
import { createCollection } from "@tanstack/react-db";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { useIsFetching, type QueryClient } from "@tanstack/react-query";
import {
  GitError,
  type GitErrorCode,
  type GitService,
  type RepoStatus,
} from "@notefig/git";
import { isWorkspaceAccessError } from "@/adapters/platform-adapter.interface";
import { path as pathutil, workspaceKey } from "@/utils/path";
import type { WorkspaceHistory } from "@/modules/history";
import { historyModule } from "@/modules/history";

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

// The query key normalizes here, not at the call sites: it was spelled two
// ways in this file — raw for the collection and useIsFetching, normalized
// for invalidate/cancel/remove — so a workspace path arriving with a
// trailing slash or a Windows respelling watched a key the collection never
// registered. useGitFetching then reported "not fetching" forever and the
// checkpoint panel's anti-flicker freeze was silently off.
//
// debug-panel.tsx (the crash fallback — deliberately self-sufficient) peeks
// this key with a hand-inlined ["git", normalized basePath]. If this key
// shape ever changes, update debug-panel in the same commit.
export function gitQueryKey(workspacePath: string) {
  return ["git", pathutil.normalize(workspacePath)] as const;
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
  // Status results are repo-relative "/"-separated (isomorphic-git's
  // filepath domain); absolutes must land in native spelling.
  return pathutil.isAbsolute(repoRelativePath)
    ? repoRelativePath
    : pathutil.join(workspacePath, pathutil.fromTreePath(repoRelativePath));
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
export async function fetchGitRows(
  service: GitService,
  workspacePath: string,
): Promise<GitRow[]> {
  const rows: GitRow[] = [];

  let status: RepoStatus | undefined;
  let statusError: SerializedGitError | undefined;
  try {
    status = await service.status();
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

// ---------------------------------------------------------------------------
// core.workspace(ws).git — one per open workspace, built from what core
// hands it: the query client and that workspace's history repo.
// ---------------------------------------------------------------------------

function createGitCollection(
  queryClient: QueryClient,
  workspacePath: string,
  service: () => GitService,
) {
  return createCollection(
    queryCollectionOptions<GitRow, string>({
      queryKey: gitQueryKey(workspacePath),
      queryClient,
      retry: false,
      staleTime: 2_000,
      queryFn: () => fetchGitRows(service(), workspacePath),
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

/** What a workspace's git timeline is built from. */
export interface GitDeps {
  workspacePath: string;
  queryClient: QueryClient;
  /** The workspace's history repo (`core.workspace(ws).history`). */
  history: Pick<WorkspaceHistory, "service" | "ready">;
}

/** One workspace's checkpoint timeline: its rows, and the actions on them. */
export interface WorkspaceGit {
  /** Repo, changed-file and checkpoint rows. Components read them through
   *  the hooks below. */
  readonly collection: GitCollection;
  /** Refetch status and checkpoints in one pass. */
  refetch(): Promise<void>;
  /** Mark the rows stale, for a change git cannot see (a file written by
   *  the app, a commit into the hidden gitdir). */
  invalidate(): void;
  /** Commit everything dirty; the new oid, or null if nothing changed. */
  saveCheckpoint(description?: string): Promise<string | null>;
  /** Revert to a checkpoint, committing local changes first (a WIP commit)
   *  so nothing is lost. */
  revertTo(checkpoint: { oid: string; hash: string }): Promise<void>;
  abortRevert(): Promise<void>;
  /** Create the history repo, then load its rows. */
  initialize(): Promise<void>;
  /** Drop the cached query state, so a reopen refetches rather than
   *  replaying stale data or a stale error. Core calls it on close. */
  dispose(): void;
}

export function createWorkspaceGit({
  workspacePath,
  queryClient,
  history,
}: GitDeps): WorkspaceGit {
  const queryKey = gitQueryKey(workspacePath);
  const collection = createGitCollection(queryClient, workspacePath, () =>
    history.service(),
  );
  const refetch = async () => {
    await collection.utils.refetch();
  };

  return {
    collection,
    refetch,
    invalidate() {
      void queryClient.invalidateQueries({ queryKey });
    },
    async saveCheckpoint(description) {
      // Cancel any in-flight fetch so a stale pre-commit response can't
      // land after the commit's own refetch.
      await queryClient.cancelQueries({ queryKey });
      try {
        return await history.service().addAllAndCommit({
          message: description?.trim() || "Commit",
          author: COMMIT_AUTHOR,
        });
      } finally {
        // Refetch even on failure — a partial add may have changed status.
        await refetch();
      }
    },
    async revertTo(checkpoint) {
      const service = history.service();
      const status = await service.status();
      const hasLocalChanges =
        status.staged.length > 0 ||
        status.unstaged.length > 0 ||
        status.untracked.length > 0;
      if (hasLocalChanges) {
        await service.addAllAndCommit({
          message: `WIP before revert ${checkpoint.hash}`,
          author: COMMIT_AUTHOR,
        });
      }
      try {
        await service.revertCommit({
          oid: checkpoint.oid,
          message: `Revert ${checkpoint.hash}`,
          author: COMMIT_AUTHOR,
        });
      } finally {
        await refetch();
      }
    },
    async abortRevert() {
      await history.service().abortRevert();
      await refetch();
    },
    async initialize() {
      await history.ready();
      await refetch();
    },
    dispose() {
      queryClient.removeQueries({ queryKey });
    },
  };
}

declare module "@notefig/core" {
  interface WorkspaceModules {
    git: WorkspaceGit;
  }
  interface CoreHookMap {
    /** Something git cannot see changed a workspace's history: a file the
     *  app wrote (its watcher echo is suppressed), or a commit into the
     *  hidden gitdir. That workspace's git rows go stale; its git instance,
     *  if it is open, refetches. */
    "git:stale": { workspacePath: string };
  }
}

export const gitModule = defineModule({
  name: "git",
  needs: ["queryClient"],
  workspace: {
    needs: [historyModule],
    create: (ctx) => {
      const git = createWorkspaceGit({
        workspacePath: pathutil.normalize(ctx.workspace.path),
        queryClient: ctx.use("queryClient"),
        history: ctx.useWorkspace("history"),
      });
      const stopListening = ctx.hooks.on("git:stale", ({ workspacePath }) => {
        if (workspaceKey(workspacePath) === ctx.workspace.key) {
          git.invalidate();
        }
      });
      return {
        ...git,
        dispose() {
          stopListening();
          git.dispose();
        },
      };
    },
    dispose: (git) => git.dispose(),
  },
});

export type SyncState = "uncommitted" | "unsynced" | "synced";

export function deriveSyncState(summary: GitSummary | undefined): SyncState {
  if (!summary) return "synced";
  if (summary.hasChanges) return "uncommitted";
  if ((summary.ahead ?? 0) > 0) return "unsynced";
  return "synced";
}
