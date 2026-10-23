import { useMemo, useSyncExternalStore } from "react";
import { type WorkspaceFiles } from "@/modules/files";
import {
  rankFileRows,
  type FileSearchOptions,
  type FileSearchResult,
} from "@/utils/file-score";
import { useCore } from "@notefig/core/react";

export type { FileSearchOptions, FileSearchResult };

interface FileRow {
  path: string;
  relativePath: string | undefined;
  type: "file" | "directory";
}

function normalizeWorkspaceSource(
  source: string | string[] | null | undefined,
): string[] | null {
  if (source === null || source === undefined) return null;
  return Array.isArray(source) ? source : [source];
}

type MetadataCollection = WorkspaceFiles["collections"]["metadata"];

function openWorkspacePaths(
  core: ReturnType<typeof useCore>,
  workspacePaths: string[] | null,
): string[] {
  const paths = workspacePaths
    ? [...workspacePaths]
    : core.workspaces.list().map((ref) => ref.path);
  // Process deepest workspaces first so nested paths are kept from the
  // innermost workspace and the outer workspace's copy is treated as a
  // duplicate.
  paths.sort((a, b) => b.length - a.length);
  return paths;
}

function* openWorkspaceMetadatas(
  core: ReturnType<typeof useCore>,
  workspacePaths: string[] | null,
): Generator<MetadataCollection> {
  for (const path of openWorkspacePaths(core, workspacePaths)) {
    if (!core.workspaces.isOpen(path)) continue;
    const metadata = core.workspace(path).files?.collections?.metadata;
    if (!metadata) continue;
    yield metadata;
  }
}

function computeFileRows(
  core: ReturnType<typeof useCore>,
  workspacePaths: string[] | null,
): FileRow[] {
  const rows: FileRow[] = [];
  const seen = new Set<string>();
  for (const metadata of openWorkspaceMetadatas(core, workspacePaths)) {
    for (const row of metadata.values()) {
      if (row.type !== "file") continue;
      if (seen.has(row.path)) continue;
      seen.add(row.path);
      rows.push({
        path: row.path,
        relativePath: row.relativePath,
        type: row.type,
      });
    }
  }
  return rows;
}

function rowsEqual(a: FileRow[], b: FileRow[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].path !== b[i].path ||
      a[i].relativePath !== b[i].relativePath ||
      a[i].type !== b[i].type
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Reactive file metadata rows from one or more open workspaces. Passing
 * `null` / `undefined` reads every workspace that is currently open. The
 * store starts and stops its subscriptions with its first and last
 * listener, so it survives React StrictMode effect replay.
 */
function useFileRows(workspacePaths: string[] | null): FileRow[] {
  const core = useCore();

  const store = useMemo(() => {
    let rows = computeFileRows(core, workspacePaths);
    const listeners = new Set<() => void>();
    let metadataStops: (() => void)[] = [];
    let stopWorkspaces: (() => void) | null = null;

    const notify = () => {
      const nextRows = computeFileRows(core, workspacePaths);
      if (rowsEqual(rows, nextRows)) return;
      rows = nextRows;
      for (const listener of listeners) listener();
    };

    const stopMetadataSubscriptions = () => {
      for (const stop of metadataStops) stop();
      metadataStops = [];
    };

    const subscribeMetadata = () => {
      stopMetadataSubscriptions();
      for (const metadata of openWorkspaceMetadatas(core, workspacePaths)) {
        const subscription = metadata.subscribeChanges(notify);
        metadataStops.push(() => subscription.unsubscribe());
      }
    };

    const startSubscriptions = () => {
      subscribeMetadata();
      stopWorkspaces = core.workspaces.subscribe(() => {
        subscribeMetadata();
        notify();
      });
    };

    const stopSubscriptions = () => {
      stopMetadataSubscriptions();
      stopWorkspaces?.();
      stopWorkspaces = null;
    };

    return {
      getRows: () => rows,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        if (listeners.size === 1) startSubscriptions();
        return () => {
          listeners.delete(listener);
          if (listeners.size === 0) stopSubscriptions();
        };
      },
    };
  }, [core, workspacePaths]);

  return useSyncExternalStore(store.subscribe, store.getRows, store.getRows);
}

/**
 * Fuzzy file-name search over one or more workspaces' eager metadata
 * collections — pure in-memory matching, no fs access (MET-155). Pass a
 * single workspace path, an array of paths, or `null` / `undefined` to
 * search every workspace that is currently open. Deliberately unaware of
 * the palette, tabs, and the editor: consumers decide what opening a
 * result means. Empty/whitespace queries return [] (unless
 * matchAllWhenEmpty). Ranking lives in utils/file-score's rankFileRows so
 * non-React callers (the prompt editor's mention suggestion) match identically.
 */
export function useFileSearch(
  workspacePath: string,
  query: string,
  options?: FileSearchOptions,
): FileSearchResult[];
export function useFileSearch(
  workspacePaths: string[],
  query: string,
  options?: FileSearchOptions,
): FileSearchResult[];
export function useFileSearch(
  allOpenWorkspaces: null | undefined,
  query: string,
  options?: FileSearchOptions,
): FileSearchResult[];
export function useFileSearch(
  source: string | string[] | null | undefined,
  query: string,
  options: FileSearchOptions = {},
): FileSearchResult[] {
  const workspacePaths = useMemo(
    () => normalizeWorkspaceSource(source),
    [source],
  );
  const data = useFileRows(workspacePaths);
  const { limit, filter, matchAllWhenEmpty } = options;
  return useMemo(
    () => rankFileRows(data, query, { limit, filter, matchAllWhenEmpty }),
    [data, query, limit, filter, matchAllWhenEmpty],
  );
}
