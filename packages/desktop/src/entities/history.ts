/**
 * Internal history entity — the agent-checkpoint timeline the sidebar panel
 * renders, backed by the workspace's second git repo (gitdir
 * `<ws>/.metrists/.git`, worktree = workspace root; see
 * utils/history-service.ts). One TanStack DB collection per workspace:
 *
 *   - `repo`       (one row): initialized flag + errors-as-data, mirroring
 *                  entities/git.ts's convention
 *   - `checkpoint` (one per commit): oid/subject/role + the task/turn ids
 *                  parsed from the commit's trailers (the durable
 *                  transcript↔checkpoint linkage). Anchoring: each turn
 *                  commits its RESULT at turn end (role agent, subject =
 *                  prompt), and any dirt found at turn start is folded
 *                  first into its own role:user "Your edits" commit — so
 *                  the timeline is always current and manual edits never
 *                  ride an agent commit. "Revert message P" = jump to P's
 *                  fold commit if one exists, else the parent of P's
 *                  result commit.
 *
 * Jumping is snapshot materialization, never history rewriting: the repo is
 * append-only, `jumpToCheckpoint` checkpoints any dirty state first (so
 * "forward" is just another jump target) and then restores the target
 * tree with `restoreTree`.
 */
import { useEffect, useMemo } from "react";
import { createCollection, useLiveQuery, eq } from "@tanstack/react-db";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { useIsFetching } from "@tanstack/react-query";
import {
  GitError,
  type GitErrorCode,
  type GitRestoreTreeResult,
} from "@notefig/git";
import { platformAdapter } from "@/adapters";
import { isWorkspaceAccessError } from "@/adapters/platform-adapter.interface";
import { normalizePath } from "@/utils/fs";
import { calculateContentHash } from "@/utils/hash";
import {
  checkpointWorkspaceHistory,
  ensureWorkspaceHistoryInitialized,
  historyGitDir,
  runExclusiveHistoryOp,
} from "@/utils/history-service";
import {
  formatCheckpointMessage,
  parseCheckpointMessage,
  USER_CHECKPOINT_AUTHOR,
  type CheckpointRole,
} from "@/utils/history-trailers";
import {
  cancelWorkspaceAgentTurns,
  notifyWorkspaceRewound,
} from "@/agent/agent-service";
import {
  getOrCreateWorkspaceCollections,
  refreshDirectoryMetadata,
} from "./files";
import { queryClient } from "./query-client";

/** A GitError flattened to data so it can live on a row. */
export interface SerializedHistoryError {
  code: GitErrorCode | "Unknown";
  message: string;
}

export interface HistoryRepoRow {
  id: "repo";
  kind: "repo";
  initialized: boolean;
  error?: SerializedHistoryError;
}

export interface HistoryCheckpointRow {
  id: string; // `cp:<oid>`
  kind: "checkpoint";
  oid: string;
  hash: string;
  /** First parent, if any — the state immediately before this commit.
   *  Revert-to-before-a-message jumps here for agent result commits. */
  parentOid?: string;
  subject: string;
  role: CheckpointRole;
  taskId?: string;
  turnId?: string;
  timestamp: number;
}

export type HistoryRow = HistoryRepoRow | HistoryCheckpointRow;

export const HISTORY_AUTHOR = USER_CHECKPOINT_AUTHOR;

const HISTORY_LOG_DEPTH = 50;

function historyQueryKey(workspacePath: string) {
  return ["history", workspacePath] as const;
}

function serializeHistoryError(error: unknown): SerializedHistoryError {
  if (error instanceof GitError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: "Unknown",
    message: error instanceof Error ? error.message : String(error),
  };
}

/** Exported for unit tests; the collection's queryFn. */
export async function fetchHistoryRows(
  workspacePath: string,
): Promise<HistoryRow[]> {
  const normalized = normalizePath(workspacePath);
  try {
    const service = await ensureWorkspaceHistoryInitialized(normalized);
    const commits = await service.log({
      repoPath: normalized,
      gitDir: historyGitDir(normalized),
      depth: HISTORY_LOG_DEPTH,
    });
    const rows: HistoryRow[] = [
      { id: "repo", kind: "repo", initialized: true },
    ];
    for (const entry of commits) {
      const fields = parseCheckpointMessage(entry.commit.message);
      rows.push({
        id: `cp:${entry.oid}`,
        kind: "checkpoint",
        oid: entry.oid,
        hash: entry.oid.slice(0, 7),
        parentOid: entry.commit.parent?.[0],
        subject: fields.subject,
        role: fields.role,
        taskId: fields.taskId,
        turnId: fields.turnId,
        timestamp: entry.commit.committer.timestamp * 1000,
      });
    }
    return rows;
  } catch (error) {
    // Only workspace-access errors escape (WorkspaceErrorBoundary); every
    // git failure becomes data on the repo row.
    if (isWorkspaceAccessError(error)) throw error;
    return [
      {
        id: "repo",
        kind: "repo",
        initialized: false,
        error: serializeHistoryError(error),
      },
    ];
  }
}

function createHistoryCollection(workspacePath: string) {
  return createCollection(
    queryCollectionOptions<HistoryRow, string>({
      queryKey: historyQueryKey(workspacePath),
      queryClient,
      retry: false,
      staleTime: 2_000,
      queryFn: () => fetchHistoryRows(workspacePath),
      getKey: (row) => row.id,
      // No mutation handlers, same as entities/git.ts: every write is a
      // plain async action + refetch (see the ghost-row rationale there /
      // MET-125).
    }),
  );
}

export type HistoryCollection = ReturnType<typeof createHistoryCollection>;

const historyCollectionsRegistry = new Map<string, HistoryCollection>();

export function getOrCreateHistoryCollection(
  workspacePath: string,
): HistoryCollection {
  const normalized = normalizePath(workspacePath);
  let collection = historyCollectionsRegistry.get(normalized);
  if (!collection) {
    collection = createHistoryCollection(normalized);
    historyCollectionsRegistry.set(normalized, collection);
  }
  return collection;
}

export function clearHistoryCollection(workspacePath: string): void {
  const normalized = normalizePath(workspacePath);
  historyCollectionsRegistry.delete(normalized);
  queryClient.removeQueries({ queryKey: historyQueryKey(normalized) });
}

export interface HistorySummary {
  initialized: boolean;
  error?: SerializedHistoryError;
}

/** The workspace's history collection as a render-stable reference. */
function useHistoryCollection(workspacePath: string): HistoryCollection;
function useHistoryCollection(
  workspacePath: string | undefined,
): HistoryCollection | undefined;
function useHistoryCollection(
  workspacePath: string | undefined,
): HistoryCollection | undefined {
  const collection = useMemo(
    () =>
      workspacePath ? getOrCreateHistoryCollection(workspacePath) : undefined,
    [workspacePath],
  );
  // A live query attaches to the collection's change stream but (observed
  // on @tanstack/db 0.6) does not move a fresh query collection out of
  // "idle" — the queryFn runs and warms the cache while zero rows ever
  // reach subscribers. Kick sync explicitly; preload() is idempotent.
  useEffect(() => {
    if (collection) void collection.preload();
  }, [collection]);
  return collection;
}

/** The repo summary row; undefined until the first fetch lands. */
export function useHistorySummary(
  workspacePath: string | undefined,
): HistorySummary | undefined {
  const collection = useHistoryCollection(workspacePath);
  const { data = [] } = useLiveQuery(
    (q) => (collection ? q.from({ history: collection }) : undefined),
    [workspacePath],
  );
  return useMemo(() => {
    const repo = (data as HistoryRow[]).find(
      (row): row is HistoryRepoRow => row.kind === "repo",
    );
    if (!repo) return undefined;
    return { initialized: repo.initialized, error: repo.error };
  }, [data]);
}

/** Checkpoints newest-first; empty until a workspace path is known. */
export function useHistoryCheckpoints(
  workspacePath: string | undefined,
): HistoryCheckpointRow[] {
  const collection = useHistoryCollection(workspacePath);
  const { data = [] } = useLiveQuery(
    (q) =>
      collection
        ? q
            .from({ history: collection })
            .where(({ history }) => eq(history.kind, "checkpoint"))
        : undefined,
    [workspacePath],
  );
  return useMemo(
    () =>
      (data as HistoryCheckpointRow[])
        .slice()
        .sort((a, b) => b.timestamp - a.timestamp),
    [data],
  );
}

/** Whether the workspace's history fetch is in flight (anti-flicker gates). */
export function useHistoryFetching(workspacePath: string): boolean {
  return (
    useIsFetching({ queryKey: historyQueryKey(workspacePath) }, queryClient) > 0
  );
}

/** Refetch the workspace's history rows. */
export async function refetchHistory(workspacePath: string): Promise<void> {
  await getOrCreateHistoryCollection(workspacePath).utils.refetch();
}

/** Debounce-friendly invalidation for file-sync's derived-state pass. */
export function invalidateHistory(workspacePath: string): void {
  void queryClient.invalidateQueries({
    queryKey: historyQueryKey(normalizePath(workspacePath)),
  });
}

/**
 * Save a manual checkpoint of everything currently dirty. Plain async
 * action — the caller renders its own pending entry while this is in
 * flight. Returns the new commit oid, or null when there was nothing to
 * commit.
 */
export async function saveManualCheckpoint(
  workspacePath: string,
  description?: string,
): Promise<string | null> {
  const normalized = normalizePath(workspacePath);
  // Cancel any in-flight fetch so a stale pre-commit response can't land
  // after the commit's own refetch.
  await queryClient.cancelQueries({ queryKey: historyQueryKey(normalized) });
  try {
    return await checkpointWorkspaceHistory(
      normalized,
      formatCheckpointMessage({
        subject: description?.trim() || "Manual checkpoint",
        role: "user",
      }),
      HISTORY_AUTHOR,
    );
  } finally {
    await refetchHistory(normalized);
  }
}

/**
 * Jump the worktree to a checkpoint's snapshot. Never rewrites history:
 * any dirty state is checkpointed first (so jumping "forward" afterwards
 * is just another jump, to that safety checkpoint), then the target tree
 * is materialized with restoreTree. Finishes by reconciling the file
 * collections with exactly the paths the restore touched.
 *
 * Agent sessions survive the jump append-only (agent-service.ts's
 * workspace-rewind section): live turns are cancelled before the restore,
 * and afterwards each live task is immediately prompted with a stale-reads
 * notice (told to acknowledge and wait).
 */
export async function jumpToCheckpoint(
  workspacePath: string,
  checkpoint: { oid: string; hash: string; subject: string },
): Promise<void> {
  const normalized = normalizePath(workspacePath);
  const service = await ensureWorkspaceHistoryInitialized(normalized);
  const gitDir = historyGitDir(normalized);

  await queryClient.cancelQueries({ queryKey: historyQueryKey(normalized) });

  let restoreResult: GitRestoreTreeResult | null = null;
  try {
    // Agents write files too: a turn still streaming while restoreTree
    // rewrites the tree would race it, and the safety checkpoint below must
    // capture the final pre-jump state — cancellation completes first
    // (queued prompts drain too; a no-op when everything is idle).
    await cancelWorkspaceAgentTurns(normalized);

    await checkpointWorkspaceHistory(
      normalized,
      formatCheckpointMessage({
        subject: `Before jump to ${checkpoint.hash}`,
        role: "user",
      }),
      HISTORY_AUTHOR,
    );

    // Queued like every history write: restore is a multi-step sequence
    // over the same index a checkpoint mutates, and the git lock throws on
    // contention rather than waiting.
    restoreResult = await runExclusiveHistoryOp(normalized, () =>
      service.restoreTree({
        repoPath: normalized,
        gitDir,
        ref: checkpoint.oid,
      }),
    );

    // Only announce a rewind that actually happened; on a failed restore the
    // cancelled turn rows are the accurate record.
    notifyWorkspaceRewound(normalized, {
      hash: checkpoint.hash,
      subject: checkpoint.subject,
    });
  } finally {
    await refetchHistory(normalized);
    await reconcileFilesAfterRestore(normalized, restoreResult);
  }
}

/**
 * Reconcile the file collections after a restore, scoped to the paths it
 * actually touched — a jump must feel surgical, not like reopening the
 * workspace. The content upsert bumps contentHash rows, which drives the
 * editors' adoption path even where fs watchers don't cover the change.
 */
async function reconcileFilesAfterRestore(
  workspacePath: string,
  result: GitRestoreTreeResult | null,
): Promise<void> {
  // The metadata refetch is a listing pass; rows are diffed, so with a
  // surgical restore only the touched files re-emit to subscribers.
  await refreshDirectoryMetadata(workspacePath);

  const { content } = getOrCreateWorkspaceCollections(workspacePath);
  if (!result) {
    // Failed restore = unknown partial state; re-read everything loaded.
    await content.utils.refetch();
    return;
  }

  const toAbsolute = (filepath: string) => `${workspacePath}/${filepath}`;

  const deleted = result.deleted
    .map(toAbsolute)
    .filter((path) => content.get(path) !== undefined);
  if (deleted.length > 0) {
    content.utils.writeDelete(deleted);
  }

  // Content is loaded on demand — only files something already loaded need
  // a re-read; everything else hydrates fresh on next open.
  const loaded = result.restored
    .map(toAbsolute)
    .filter((path) => content.get(path) !== undefined);
  if (loaded.length > 0) {
    const read = await platformAdapter.fs.readFiles(loaded);
    content.utils.writeUpsert(
      read.succeeded.map((file) => ({
        path: file.path,
        content: file.content,
        contentHash: calculateContentHash(file.content),
      })),
    );
  }
}
