/**
 * Utility functions for path normalization and comparison
 */

/**
 * Normalizes a file path by ensuring it starts with a forward slash
 * and removing any duplicate slashes
 */
export function normalizePath(path: string): string {
  if (!path) return "/";

  // Ensure path starts with /
  const withLeadingSlash = path.startsWith("/") ? path : `/${path}`;

  // Remove duplicate slashes
  const normalized = withLeadingSlash.replace(/\/+/g, "/");

  // Remove trailing slash unless it's the root
  return normalized.length > 1 && normalized.endsWith("/")
    ? normalized.slice(0, -1)
    : normalized;
}

/**
 * Compares two file paths for equality, ignoring leading slash differences
 * and normalizing both paths before comparison
 */
export function pathsEqual(path1: string, path2: string): boolean {
  if (!path1 || !path2) return false;

  const normalized1 = normalizePath(path1);
  const normalized2 = normalizePath(path2);

  return normalized1 === normalized2;
}

/**
 * Checks if a file path exists in an array of paths, using normalized comparison
 */
export function pathExistsIn(targetPath: string, paths: string[]): boolean {
  if (!targetPath || !paths || paths.length === 0) return false;

  const normalizedTarget = normalizePath(targetPath);

  return paths.some((path) => {
    const normalizedPath = normalizePath(path);
    return normalizedPath === normalizedTarget;
  });
}

/**
 * Finds a matching path from an array of paths using normalized comparison
 * Returns the original path from the array if found, null otherwise
 */
export function findMatchingPath(
  targetPath: string,
  paths: string[],
): string | null {
  if (!targetPath || !paths || paths.length === 0) return null;

  const normalizedTarget = normalizePath(targetPath);

  const matchingPath = paths.find((path) => {
    const normalizedPath = normalizePath(path);
    return normalizedPath === normalizedTarget;
  });

  return matchingPath || null;
}
