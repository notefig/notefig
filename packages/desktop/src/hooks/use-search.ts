import { useState, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { platformAdapter } from "@/adapters";
import { IGNORE_RULES } from "@/utils/ignore";
import type {
  SearchOptions,
  SearchMatch,
} from "@/adapters/platform-adapter.interface";

export interface UseSearchOptions {
  query: string;
  caseSensitive?: boolean;
  useRegex?: boolean;
  filePattern?: string;
  maxResults?: number;
}

export interface UseSearchResult {
  results: SearchMatch[];
  isSearching: boolean;
  error: Error | null;
  resultCount: number;
  fileCount: number;
}

const NO_RESULTS: SearchMatch[] = [];

/**
 * Debounced workspace search hook using TanStack Query for data fetching.
 *
 * Debounces the query string by 300ms, then runs
 * platformAdapter.fs.searchContent as a subscribed query. Revalidation on
 * filesystem changes happens through the central invalidator in
 * utils/file-sync.ts, which invalidates ["search-content", workspacePath].
 */
export function useSearch(
  workspacePath: string,
  options: UseSearchOptions,
): UseSearchResult {
  const { query, caseSensitive, useRegex, filePattern, maxResults } = options;

  const [debouncedQuery, setDebouncedQuery] = useState(query);
  useEffect(() => {
    if (query.trim() === "") {
      setDebouncedQuery("");
      return;
    }
    const timer = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(timer);
  }, [query]);

  const trimmed = debouncedQuery.trim();

  const searchOptions: SearchOptions = {
    query: trimmed,
    caseSensitive,
    useRegex,
    filePattern: filePattern || undefined,
    maxResults,
    ignore: IGNORE_RULES,
  };

  const { data, isFetching, error } = useQuery<SearchMatch[], Error>({
    queryKey: [
      "search-content",
      workspacePath,
      trimmed,
      caseSensitive,
      useRegex,
      filePattern,
      maxResults,
    ],
    queryFn: () => platformAdapter.fs.searchContent(workspacePath, searchOptions),
    enabled: trimmed !== "",
    retry: false,
    placeholderData: (previous) => previous,
    gcTime: 30_000,
  });

  const results = trimmed === "" ? NO_RESULTS : (data ?? NO_RESULTS);

  const { resultCount, fileCount } = useMemo(() => {
    const files = new Set(results.map((r) => r.filePath));
    return { resultCount: results.length, fileCount: files.size };
  }, [results]);

  return {
    results,
    isSearching: isFetching,
    error: error ?? null,
    resultCount,
    fileCount,
  };
}
