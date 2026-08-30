import {
  useState,
  useCallback,
  useMemo,
  useRef,
  useImperativeHandle,
  forwardRef,
} from "react";
import { useKeyHold } from "@tanstack/react-hotkeys";
import {
  Search,
  X,
  CaseSensitive,
  SlidersHorizontal,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { cn } from "@notefig/ui/utils";
import { useSearch } from "@/hooks/use-search";
import { ScrollArea } from "@notefig/ui/scroll-area";
import { getFileName } from "@/utils/fs";
import type { SearchMatch } from "@/adapters/platform-adapter.interface";
import type { OpenFileInLayoutOptions } from "@/utils/dockable-layout";
import { requestNavigation } from "@/components/editor/editor-store";
import { suppressTabFocus } from "@/tabs/tab-controllers";
import { useWorkspaceTabs } from "@/components/workspace-tabs-provider";

interface SearchPanelProps {
  workspacePath: string;
}

export interface SearchPanelHandle {
  /** Focus the search input, select its text, and optionally set the file filter. */
  focusInput: (options?: {
    filePattern?: string;
    initialQuery?: string;
  }) => void;
}

export const SearchPanel = forwardRef<SearchPanelHandle, SearchPanelProps>(
  function SearchPanel({ workspacePath }, ref) {
    const isMetaHeld = useKeyHold("Meta");
    const isControlHeld = useKeyHold("Control");
    const isModHeld = isMetaHeld || isControlHeld;
    const { openFile } = useWorkspaceTabs();

    const handleMatchClick = useCallback(
      (
        match: SearchMatch,
        options?: Omit<OpenFileInLayoutOptions, "tabId">,
      ) => {
        openFile({
          tabId: match.filePath,
          intent: options?.intent ?? "replace",
        });
        requestNavigation(match.filePath, match);
      },
      [openFile],
    );

    const inputRef = useRef<HTMLInputElement>(null);
    const [query, setQuery] = useState("");
    const [caseSensitive, setCaseSensitive] = useState(false);
    const [filePattern, setFilePattern] = useState("");
    const [showFilters, setShowFilters] = useState(false);
    const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(
      new Set(),
    );

    const focusSearchInput = useCallback(() => {
      const input = inputRef.current;
      if (!input) return false;

      input.focus({ preventScroll: true });
      input.select();

      return document.activeElement === input;
    }, []);

    useImperativeHandle(ref, () => ({
      focusInput: (options) => {
        const pattern = options?.filePattern;
        const initialQuery = options?.initialQuery;

        // Suppress editor focus stealing for 500ms to prevent race conditions
        suppressTabFocus(500);

        if (initialQuery !== undefined) {
          setQuery(initialQuery);
        }

        if (pattern) {
          setFilePattern(pattern);
          setShowFilters(true);
        } else {
          // Global search — clear any existing file filter
          setFilePattern("");
          setShowFilters(false);
        }

        requestAnimationFrame(() => {
          focusSearchInput();
        });
      },
    }));

    const { results, isSearching, error, resultCount, fileCount } = useSearch(
      workspacePath,
      {
        query,
        caseSensitive,
        filePattern: filePattern || undefined,
      },
    );

    const groupedResults = useMemo(() => {
      const groups = new Map<string, SearchMatch[]>();
      for (const match of results) {
        const filePath = match.filePath;
        const existing = groups.get(filePath);
        if (existing) {
          existing.push(match);
        } else {
          groups.set(filePath, [match]);
        }
      }

      const entries = [...groups.entries()];
      entries.sort((a, b) => {
        const nameA = getFileName(a[0]).toLowerCase();
        const nameB = getFileName(b[0]).toLowerCase();
        return nameA.localeCompare(nameB);
      });

      return entries;
    }, [results]);

    const toggleFileCollapsed = useCallback((filePath: string) => {
      setCollapsedFiles((prev) => {
        const next = new Set(prev);
        if (next.has(filePath)) {
          next.delete(filePath);
        } else {
          next.add(filePath);
        }
        return next;
      });
    }, []);

    const handleClear = useCallback(() => {
      setQuery("");
    }, []);

    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-1 px-2 pt-2 pb-1">
          <div className="flex-1 min-w-0 flex items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1 text-sm">
            <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search"
              className="flex-1 bg-transparent outline-none placeholder:text-muted-foreground text-sm min-w-0"
            />
            <button
              onClick={() => setCaseSensitive(!caseSensitive)}
              className={cn(
                "p-0.5 rounded transition-colors shrink-0",
                caseSensitive
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
              title="Match case"
            >
              <CaseSensitive className="w-4 h-4" />
            </button>
            {query && (
              <button
                onClick={handleClear}
                className="p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors shrink-0"
                title="Clear search"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          <button
            onClick={() => {
              const willHide = showFilters;
              setShowFilters(!showFilters);
              if (willHide) {
                setFilePattern("");
              }
            }}
            className={cn(
              "p-1.5 rounded transition-colors shrink-0",
              showFilters
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
            title="Toggle filters"
          >
            <SlidersHorizontal className="w-4 h-4" />
          </button>
        </div>

        {showFilters && (
          <div className="px-2 pb-1">
            <input
              type="text"
              value={filePattern}
              onChange={(e) => setFilePattern(e.target.value)}
              placeholder="File filter (e.g. *.md)"
              className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
        )}

        {query.trim() && (
          <div className="flex items-center px-2 py-1 text-xs text-muted-foreground">
            {isSearching ? (
              <span className="inline-flex items-center gap-1">
                searching
                <span className="animate-pulse">...</span>
              </span>
            ) : (
              `${resultCount} result${resultCount !== 1 ? "s" : ""} in ${fileCount} file${fileCount !== 1 ? "s" : ""}`
            )}
          </div>
        )}

        {error && (
          <div className="px-2 py-1 text-xs text-destructive">
            {error.message}
          </div>
        )}

        <ScrollArea className="flex-1 min-h-0">
          {groupedResults.map(([filePath, matches]) => {
            const isCollapsed = collapsedFiles.has(filePath);
            const fileName = getFileName(filePath);

            return (
              <div key={filePath}>
                <button
                  onClick={() => toggleFileCollapsed(filePath)}
                  className="flex items-center w-full px-2 py-1 text-sm hover:bg-accent/50 transition-colors gap-1"
                >
                  {isCollapsed ? (
                    <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                  ) : (
                    <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                  )}
                  <span className="truncate text-start flex-1">{fileName}</span>
                  <span className="text-xs text-muted-foreground shrink-0">
                    {matches.length}
                  </span>
                </button>

                {!isCollapsed &&
                  matches.map((match) => (
                    <SearchResultItem
                      key={`${filePath}:${match.matchText}:${match.occurrence}`}
                      match={match}
                      query={query}
                      caseSensitive={caseSensitive}
                      onClick={() =>
                        handleMatchClick(match, {
                          intent: isModHeld ? "new-tab" : "replace",
                        })
                      }
                    />
                  ))}
              </div>
            );
          })}

          {!isSearching && query.trim() && resultCount === 0 && !error && (
            <div className="px-2 py-4 text-sm text-muted-foreground text-center">
              No results found
            </div>
          )}
        </ScrollArea>
      </div>
    );
  },
);

function SearchResultItem({
  match,
  query,
  caseSensitive,
  onClick,
}: {
  match: SearchMatch;
  query: string;
  caseSensitive: boolean;
  onClick: () => void;
}) {
  const lineContent = match.lineText;

  const segments = useMemo(() => {
    if (!query.trim()) return [{ text: lineContent, highlight: false }];

    const flags = caseSensitive ? "g" : "gi";
    let pattern: RegExp;
    try {
      // Escape query for literal matching
      const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      pattern = new RegExp(escaped, flags);
    } catch {
      return [{ text: lineContent, highlight: false }];
    }

    const result: { text: string; highlight: boolean }[] = [];
    let lastIndex = 0;

    for (const m of lineContent.matchAll(pattern)) {
      if (m.index !== undefined && m.index > lastIndex) {
        result.push({
          text: lineContent.slice(lastIndex, m.index),
          highlight: false,
        });
      }
      result.push({ text: m[0], highlight: true });
      lastIndex = (m.index ?? 0) + m[0].length;
    }

    if (lastIndex < lineContent.length) {
      result.push({
        text: lineContent.slice(lastIndex),
        highlight: false,
      });
    }

    return result.length > 0
      ? result
      : [{ text: lineContent, highlight: false }];
  }, [lineContent, query, caseSensitive]);

  return (
    <button
      onClick={onClick}
      className="flex items-center w-full ps-7 pe-2 py-0.5 text-sm hover:bg-accent/50 transition-colors text-start"
    >
      <span className="truncate">
        {segments.map((seg, i) =>
          seg.highlight ? (
            <mark
              key={i}
              className="bg-yellow-500/30 text-foreground rounded-sm px-px"
            >
              {seg.text}
            </mark>
          ) : (
            <span key={i}>{seg.text}</span>
          ),
        )}
      </span>
    </button>
  );
}
