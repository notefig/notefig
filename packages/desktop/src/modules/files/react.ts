/**
 * Reading a workspace's file rows from React: the open-tab join, fetch
 * state, and the content watch that follows the open tabs.
 */
import { useEffect, useMemo } from "react";
import { useCore, useWorkspaceModule } from "@notefig/core/react";
import {
  useLiveQuery,
  eq,
  inArray,
  coalesce,
  isUndefined,
  not,
} from "@tanstack/react-db";
import { useIsFetching } from "@tanstack/react-query";
import { workspaceKey } from "@/utils/path";
import type { FileMetadata, WorkspaceCollections } from "./files";

/**
 * A file row shaped for open tabs: metadata joined with content.
 * Content loads on demand; `isContentLoaded` is false until it arrives.
 */
export interface OpenFileRow extends FileMetadata {
  content: string;
  isContentLoaded: boolean;
  contentError?: string;
}

/**
 * Metadata ⋈ content left-join for a set of open files. Files appear as soon
 * as metadata is in (metadata loads eagerly); content follows on demand.
 * A null workspace (the path is in no open workspace) yields no rows.
 */
export function useOpenFileRows(
  workspacePath: string | null,
  paths: string[],
): OpenFileRow[] {
  const collections = useWorkspaceModule(workspacePath, "files")?.collections;
  const { data = [] } = useLiveQuery(
    (q) =>
      collections === undefined || paths.length === 0
        ? undefined
        : q
            .from({ file: collections.metadata })
            .where(({ file }) => inArray(file.path, paths))
            .leftJoin({ content: collections.content }, ({ file, content }) =>
              eq(file.path, content.path),
            )
            // The callback runs once at build time with ref PROXIES, not
            // per row — plain JS operators on them constant-fold. The old
            // `content !== undefined` compiled to a hardcoded `true` and
            // `?? ""` to a no-op, so rows claimed loaded content while the
            // join was still empty (undefined). Everything data-dependent
            // must go through query operators.
            .select(({ file, content }) => ({
              ...file,
              content: coalesce(content?.content, ""),
              contentHash: coalesce(content?.contentHash, ""),
              isContentLoaded: not(isUndefined(content?.content)),
              contentError: content?.error,
            })),
    [collections, ...paths],
  );
  return data as OpenFileRow[];
}

/** Whether a load is in flight for one of the query kinds — the
 *  workspace's, or any open workspace's when no path is given (the dock
 *  spans them all). */
function useFilesFetching(
  kind: "file-metadata" | "file-content",
  workspacePath?: string,
): boolean {
  const { queryClient } = useCore();
  const queryKey = useMemo(
    () => (workspacePath === undefined ? [kind] : [kind, workspacePath]),
    [kind, workspacePath],
  );
  return useIsFetching({ queryKey }, queryClient) > 0;
}

/** Whether an eager metadata load is in flight. */
export function useMetadataFetching(workspacePath?: string): boolean {
  return useFilesFetching("file-metadata", workspacePath);
}

/** Whether an on-demand content load is in flight. */
export function useContentFetching(workspacePath?: string): boolean {
  return useFilesFetching("file-content", workspacePath);
}

/**
 * Keep each open workspace's content watch on its open file tabs
 * (`openFilesByWorkspace`: workspace → its open file paths). A workspace
 * with none stops watching content; every watch stops on unmount.
 */
export function useContentWatches(
  openFilesByWorkspace: Map<string, string[]>,
): void {
  const core = useCore();
  useEffect(() => {
    const byKey = new Map(
      [...openFilesByWorkspace].map(([path, paths]) => [
        workspaceKey(path),
        paths,
      ]),
    );
    const sync = () => {
      for (const workspace of core.workspaces.list()) {
        core
          .workspace(workspace.path)
          .files.watchContent(byKey.get(workspace.key) ?? []);
      }
    };
    sync();
    // A workspace core opens later gets its watch too.
    return core.workspaces.subscribe(sync);
  }, [core, openFilesByWorkspace]);
  useEffect(
    () => () => {
      for (const workspace of core.workspaces.list()) {
        core.workspace(workspace.path).files.watchContent([]);
      }
    },
    [core],
  );
}
