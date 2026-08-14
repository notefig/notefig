import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLiveQuery } from "@tanstack/react-db";
import { getOrCreateWorkspaceCollections } from "@/entities/files";
import { platformAdapter } from "@/adapters";
import { getFileExtension } from "@/utils/fs";
import {
  buildGraphData,
  extractHrefFromMarkdownLink,
  type GraphData,
} from "@/utils/graph-data";

// Matches the markdown extensions isTextFile() (utils/fs.ts) treats as
// markdown — the only file kind the graph draws nodes for.
const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdown", "mkd"]);

// Whole `[text](href)` (optionally `"title"`) constructs. search returns
// whole-match text (not capture groups), so the href itself is pulled out
// of each match afterwards via extractHrefFromMarkdownLink.
const MARKDOWN_LINK_PATTERN = String.raw`\[[^\]]*\]\([^)\s]+[^)]*\)`;

// The glob matcher backing filePattern (both the Tauri and browser search
// implementations) has no brace/alternation support, so a single glob can't
// cover every markdown extension. ".md" is overwhelmingly dominant in
// practice; the rarer aliases (.markdown, .mdown, .mkd) are skipped for v1
// rather than fanning out into multiple search calls.
const MARKDOWN_FILE_PATTERN = "*.md";

export interface UseWorkspaceGraphDataResult {
  graphData: GraphData;
  markdownPaths: string[];
  isLoading: boolean;
}

/**
 * Shared by the Graph View tab and the file-link picker: the workspace's
 * markdown files as nodes, plus every resolved internal markdown link
 * between them as edges. Backed by the same `["search-content",
 * workspacePath]` invalidation channel as workspace search
 * (utils/file-sync.ts), so it refetches for free on every filesystem
 * change — no new plumbing.
 */
export function useWorkspaceGraphData(
  workspacePath: string,
): UseWorkspaceGraphDataResult {
  const { metadata } = getOrCreateWorkspaceCollections(workspacePath);

  const { data: fileMetadataList = [] } = useLiveQuery(
    (q) =>
      q.from({ file: metadata }).select(({ file }) => ({
        path: file.path,
        type: file.type,
      })),
    [workspacePath],
  );

  const markdownPaths = useMemo(
    () =>
      fileMetadataList
        .filter(
          (f) =>
            f.type === "file" &&
            MARKDOWN_EXTENSIONS.has(getFileExtension(f.path)),
        )
        .map((f) => f.path),
    [fileMetadataList],
  );

  const { data: rawMatches = [], isLoading: isSearchLoading } = useQuery({
    queryKey: ["search-content", workspacePath, "graph-links"],
    queryFn: () =>
      platformAdapter.fs.searchContent(workspacePath, {
        query: MARKDOWN_LINK_PATTERN,
        useRegex: true,
        filePattern: MARKDOWN_FILE_PATTERN,
        // Every markdown link is one match; default cap (1000) would
        // silently truncate a heavily cross-linked workspace.
        maxResults: 20_000,
      }),
    enabled: markdownPaths.length > 0,
  });

  const graphData = useMemo(() => {
    const rawLinks = rawMatches
      .map((match) => {
        const href = extractHrefFromMarkdownLink(match.matchText);
        return href ? { sourcePath: match.filePath, href } : null;
      })
      .filter(
        (link): link is { sourcePath: string; href: string } => link !== null,
      );

    return buildGraphData(markdownPaths, workspacePath, rawLinks);
  }, [markdownPaths, workspacePath, rawMatches]);

  const isLoading = fileMetadataList.length === 0 || isSearchLoading;

  return { graphData, markdownPaths, isLoading };
}
