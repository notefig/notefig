import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { platformAdapter } from "@/adapters";
import { queryClient } from "@/utils/collections";
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

/**
 * Debounced workspace search hook using TanStack Query for data fetching.
 *
 * Debounces the query string by 300ms, then uses queryClient.fetchQuery
 * to call platformAdapter.searchContent. Cancels in-flight searches when
 * the query or options change.
 *
 * Revalidates automatically when file content or metadata changes
 * (via platform events), debounced at 500ms.
 */
export function useSearch(
  workspacePath: string,
  options: UseSearchOptions,
): UseSearchResult {
  const { query, caseSensitive, useRegex, filePattern, maxResults } = options;

  // Debounced query
  const [debouncedQuery, setDebouncedQuery] = useState(query);
  useEffect(() => {
    if (query.trim() === "") {
      setDebouncedQuery("");
      return;
    }
    const timer = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(timer);
  }, [query]);

  const [results, setResults] = useState<SearchMatch[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Generation counter — incremented on file system changes to re-trigger search
  const [generation, setGeneration] = useState(0);

  // Track whether there's an active search (for skipping invalidation when idle)
  const hasActiveSearch = debouncedQuery.trim() !== "";

  // Listen for file system changes and bump generation (debounced 500ms)
  useEffect(() => {
    if (!hasActiveSearch) return;

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = platformAdapter.addEventListener((event) => {
      if (
        event.type === "fs-metadata-changed" ||
        event.type === "fs-content-changed"
      ) {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          setGeneration((g) => g + 1);
        }, 500);
      }
    });

    return () => {
      cleanup();
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  }, [hasActiveSearch]);

  // AbortController ref for cancellation
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    // Cancel any in-flight search
    abortRef.current?.abort();

    const trimmed = debouncedQuery.trim();
    if (trimmed === "") {
      setResults([]);
      setIsSearching(false);
      setError(null);
      return;
    }

    const abortController = new AbortController();
    abortRef.current = abortController;

    const searchOptions: SearchOptions = {
      query: trimmed,
      caseSensitive,
      useRegex,
      filePattern: filePattern || undefined,
      maxResults,
    };

    // Include generation in query key to bypass TanStack Query cache on revalidation
    const queryKey = [
      "search-content",
      workspacePath,
      trimmed,
      caseSensitive,
      useRegex,
      filePattern,
      maxResults,
      generation,
    ];

    setIsSearching(true);
    setError(null);

    queryClient
      .fetchQuery({
        queryKey,
        queryFn: () =>
          platformAdapter.searchContent(workspacePath, searchOptions),
        gcTime: 0,
      })
      .then((data) => {
        if (!abortController.signal.aborted) {
          setResults(data);
          setIsSearching(false);
        }
      })
      .catch((err: unknown) => {
        if (!abortController.signal.aborted) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setResults([]);
          setIsSearching(false);
        }
      });

    return () => {
      abortController.abort();
    };
  }, [
    workspacePath,
    debouncedQuery,
    caseSensitive,
    useRegex,
    filePattern,
    maxResults,
    generation,
  ]);

  const { resultCount, fileCount } = useMemo(() => {
    const files = new Set(results.map((r) => r.location.filePath));
    return { resultCount: results.length, fileCount: files.size };
  }, [results]);

  return { results, isSearching, error, resultCount, fileCount };
}
