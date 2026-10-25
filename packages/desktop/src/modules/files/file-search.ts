/**
 * File search across every open workspace (MET-255): each workspace's
 * metadata collection is ranked on its own and only the top matches of
 * each are merged, so a keystroke costs one pass per workspace and a file
 * change re-ranks only the workspace it happened in. Nothing is copied out
 * of the collections.
 */
import type { Core } from "@notefig/core";
import {
  compareScoredPaths,
  DEFAULT_FILE_SEARCH_LIMIT,
  rankFileRows,
  type FileSearchOptions,
  type FileSearchResult,
} from "@/utils/file-score";
import { relativeTreePath } from "@/utils/path";
import type { WorkspaceCollections, WorkspaceFiles } from "./files";

type MetadataCollection = WorkspaceCollections["metadata"];

export interface WorkspaceFileSearchResult extends FileSearchResult {
  workspacePath: string;
}

export interface WorkspaceFileSearchOptions extends FileSearchOptions {
  /** Wins ties against the other workspaces (the workspace in front). */
  preferWorkspace?: string;
}

/** One open workspace as the search sees it. */
export interface SearchedWorkspace {
  path: string;
  metadata: MetadataCollection;
  /** Open workspaces inside this one: their files are found there. */
  nested: string[];
  /** Changes whenever `metadata` does: the ranking cache's key. */
  version: number;
}

/**
 * The open workspaces and their metadata versions, as an external store.
 * A metadata change replaces only that workspace's entry; opening or
 * closing a workspace rebuilds the list. Subscriptions start with the
 * first listener and stop with the last.
 */
export function createSearchedWorkspaces(
  core: Pick<Core, "workspaces" | "workspace">,
) {
  // Global, so a StrictMode resubscribe never reuses a version a cached
  // ranking was keyed on.
  let nextVersion = 0;
  let snapshot: SearchedWorkspace[] = [];
  let stops: (() => void)[] = [];
  let stopWorkspaces: (() => void) | null = null;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };

  const bump = (path: string) => {
    snapshot = snapshot.map((ws) =>
      ws.path === path ? { ...ws, version: nextVersion++ } : ws,
    );
    emit();
  };

  const rebuild = () => {
    for (const stop of stops) stop();
    const paths = core.workspaces.list().map((ref) => ref.path);
    snapshot = paths.flatMap((path) => {
      const files = core.workspace(path).files as WorkspaceFiles | undefined;
      if (!files) return [];
      const nested = paths.filter(
        (other) =>
          other !== path && relativeTreePath(path, other) !== undefined,
      );
      const metadata = files.collections.metadata;
      return [{ path, metadata, nested, version: nextVersion++ }];
    });
    stops = snapshot.map(({ path, metadata }) => {
      const subscription = metadata.subscribeChanges(() => bump(path));
      return () => subscription.unsubscribe();
    });
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) {
        rebuild();
        stopWorkspaces = core.workspaces.subscribe(() => {
          rebuild();
          emit();
        });
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        for (const stop of stops) stop();
        stops = [];
        stopWorkspaces?.();
        stopWorkspaces = null;
      };
    },
  };
}

/** Workspace files only: directories and files of nested workspaces drop. */
function* searchableRows({ metadata, nested }: SearchedWorkspace) {
  for (const row of metadata.values()) {
    if (row.type !== "file") continue;
    if (nested.some((inner) => relativeTreePath(inner, row.path) !== undefined))
      continue;
    yield row;
  }
}

interface CachedRanking {
  version: number;
  query: string;
  options: FileSearchOptions;
  results: WorkspaceFileSearchResult[];
}

/**
 * A searcher that remembers each workspace's last ranking, so a re-render
 * after one workspace changed re-ranks that workspace alone.
 */
export function createFileSearch() {
  const cache = new WeakMap<MetadataCollection, CachedRanking>();

  const rankWorkspace = (
    ws: SearchedWorkspace,
    query: string,
    options: FileSearchOptions,
  ): WorkspaceFileSearchResult[] => {
    const cached = cache.get(ws.metadata);
    if (
      cached?.version === ws.version &&
      cached.query === query &&
      cached.options.limit === options.limit &&
      cached.options.filter === options.filter &&
      cached.options.matchAllWhenEmpty === options.matchAllWhenEmpty
    ) {
      return cached.results;
    }
    const results = rankFileRows(searchableRows(ws), query, options).map(
      (result) => ({ ...result, workspacePath: ws.path }),
    );
    cache.set(ws.metadata, { version: ws.version, query, options, results });
    return results;
  };

  return (
    workspaces: SearchedWorkspace[],
    query: string,
    {
      preferWorkspace,
      limit = DEFAULT_FILE_SEARCH_LIMIT,
      ...options
    }: WorkspaceFileSearchOptions = {},
  ): WorkspaceFileSearchResult[] => {
    const merged = workspaces.flatMap((ws) =>
      rankWorkspace(ws, query, { ...options, limit }),
    );
    merged.sort(
      (a, b) =>
        b.score - a.score ||
        Number(b.workspacePath === preferWorkspace) -
          Number(a.workspacePath === preferWorkspace) ||
        compareScoredPaths(a, b),
    );
    return merged.slice(0, limit);
  };
}
