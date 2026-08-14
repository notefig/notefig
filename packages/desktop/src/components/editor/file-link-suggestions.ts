import type { GraphEdge } from "@/utils/graph-data";
import { getDirectoryPath, getFileName } from "@/utils/fs";

export interface FileLinkCandidate {
  path: string;
  label: string;
}

const sortByName = (paths: string[]): string[] =>
  [...paths].sort((a, b) => getFileName(a).localeCompare(getFileName(b)));

/**
 * Ranks candidate files for the file-link picker: graph neighbors of
 * `currentFilePath` first (files it already links to/from — reuses the
 * Graph View's edge data), then same-directory siblings, then the rest of
 * the workspace alphabetically. Excludes currentFilePath itself.
 */
export function rankFileLinkCandidates(
  currentFilePath: string,
  markdownPaths: string[],
  graphLinks: GraphEdge[],
): FileLinkCandidate[] {
  const neighborPaths = new Set<string>();
  for (const { source, target } of graphLinks) {
    if (source === currentFilePath) neighborPaths.add(target);
    else if (target === currentFilePath) neighborPaths.add(source);
  }

  const currentDir = getDirectoryPath(currentFilePath);
  const siblingPaths = new Set(
    markdownPaths.filter(
      (path) =>
        path !== currentFilePath && getDirectoryPath(path) === currentDir,
    ),
  );

  const neighbors = sortByName(
    markdownPaths.filter((path) => neighborPaths.has(path)),
  );
  const siblings = sortByName(
    markdownPaths.filter(
      (path) => siblingPaths.has(path) && !neighborPaths.has(path),
    ),
  );
  const rest = sortByName(
    markdownPaths.filter(
      (path) =>
        path !== currentFilePath &&
        !neighborPaths.has(path) &&
        !siblingPaths.has(path),
    ),
  );

  return [...neighbors, ...siblings, ...rest].map((path) => ({
    path,
    label: getFileName(path),
  }));
}
