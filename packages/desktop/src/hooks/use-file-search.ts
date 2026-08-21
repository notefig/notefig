import { useMemo } from "react";
import { eq, useLiveQuery } from "@tanstack/react-db";
import { useFileCollections } from "@/entities/files";
import { getFileName } from "@/utils/fs";
import { compareScoredPaths, scoreFilePath } from "@/utils/file-score";

export interface FileSearchResult {
  path: string;
  relativePath: string;
  title: string;
  score: number;
}

export interface FileSearchOptions {
  /** Cap on returned rows — the palette's list is not virtualized. */
  limit?: number;
  /** Openability gate (e.g. canOpenFile); paths failing it never surface. */
  filter?: (path: string) => boolean;
  /**
   * Empty-query behavior: [] by default; the mention picker passes true to
   * list files immediately on a bare "@" (shallowest paths first).
   */
  matchAllWhenEmpty?: boolean;
}

const DEFAULT_LIMIT = 10;

/**
 * Fuzzy file-name search over the workspace's eager metadata collection —
 * pure in-memory matching, no fs access (MET-155). Deliberately unaware of
 * the palette, tabs, and the editor: consumers decide what opening a result
 * means. Empty/whitespace queries return [].
 */
export function useFileSearch(
  workspacePath: string,
  query: string,
  {
    limit = DEFAULT_LIMIT,
    filter,
    matchAllWhenEmpty = false,
  }: FileSearchOptions = {},
): FileSearchResult[] {
  const { metadata } = useFileCollections(workspacePath);
  const { data = [] } = useLiveQuery(
    (q) =>
      q
        .from({ file: metadata })
        .where(({ file }) => eq(file.type, "file"))
        .select(({ file }) => ({
          path: file.path,
          relativePath: file.relativePath,
        })),
    [workspacePath],
  );

  const trimmedQuery = query.trim();
  return useMemo(() => {
    if (!trimmedQuery && !matchAllWhenEmpty) return [];
    const results: FileSearchResult[] = [];
    for (const row of data) {
      // Rows without a relativePath are loose files (outside the workspace
      // tree) — hidden to match what the file tree shows.
      if (!row.relativePath) continue;
      if (filter && !filter(row.path)) continue;
      // Empty query with matchAllWhenEmpty: every file at score 0 — the
      // comparator then orders by shortest path, then alphabetically.
      const score = trimmedQuery
        ? scoreFilePath(trimmedQuery, row.relativePath)
        : 0;
      if (trimmedQuery && score <= 0) continue;
      results.push({
        path: row.path,
        relativePath: row.relativePath,
        title: getFileName(row.path),
        score,
      });
    }
    results.sort(compareScoredPaths);
    return results.slice(0, limit);
  }, [data, trimmedQuery, limit, filter, matchAllWhenEmpty]);
}
