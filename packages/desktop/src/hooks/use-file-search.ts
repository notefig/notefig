import { useMemo } from "react";
import { eq, useLiveQuery } from "@tanstack/react-db";
import { useFileCollections } from "@/entities/files";
import {
  rankFileRows,
  type FileSearchOptions,
  type FileSearchResult,
} from "@/utils/file-score";

export type { FileSearchOptions, FileSearchResult };

/**
 * Fuzzy file-name search over the workspace's eager metadata collection —
 * pure in-memory matching, no fs access (MET-155). Deliberately unaware of
 * the palette, tabs, and the editor: consumers decide what opening a result
 * means. Empty/whitespace queries return [] (unless matchAllWhenEmpty).
 * Ranking lives in utils/file-score's rankFileRows so non-React callers
 * (the prompt editor's mention suggestion) match identically.
 */
export function useFileSearch(
  workspacePath: string,
  query: string,
  options: FileSearchOptions = {},
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

  const { limit, filter, matchAllWhenEmpty } = options;
  return useMemo(
    () => rankFileRows(data, query, { limit, filter, matchAllWhenEmpty }),
    [data, query, limit, filter, matchAllWhenEmpty],
  );
}
