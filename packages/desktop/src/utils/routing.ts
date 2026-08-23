import { path as pathutil, relativeTreePath } from "./path";

/**
 * Workspace and file paths travel through the router as ONE opaque
 * percent-encoded segment holding the NATIVE absolute path — the decoded
 * value must round-trip byte-identical to the collection/registry keys built
 * from it (`use-workspace-params.ts` hands it straight to them). Never
 * normalize or re-spell here.
 */
export function encodePathForUrl(path: string): string {
  return encodeURIComponent(path);
}

export function decodePathFromUrl(encodedPath: string): string {
  return decodeURIComponent(encodedPath);
}

export function getBasePathFromUrl(basePath?: string): string | undefined {
  if (!basePath) return undefined;
  return decodePathFromUrl(basePath);
}

export function getAbsolutePathFromUrl(
  encodedAbsolutePath?: string,
): string | undefined {
  if (!encodedAbsolutePath) return undefined;
  return decodePathFromUrl(encodedAbsolutePath);
}

/** Historical slash-prepend fixup for legacy relative inputs. Prepending to
 *  a native absolute (`C:\…`) would corrupt it, so guard on isAbsolute. */
function toRouteAbsolute(path: string): string {
  return pathutil.isAbsolute(path) ? path : "/" + path;
}

export function buildEditFileUrl(
  basePath: string,
  absoluteFilePath: string,
): string {
  const normalizedBasePath = toRouteAbsolute(basePath);
  return `/${encodePathForUrl(normalizedBasePath)}/edit/${encodePathForUrl(absoluteFilePath)}`;
}

export function buildPreviewFileUrl(
  basePath: string,
  absoluteFilePath: string,
): string {
  const normalizedBasePath = toRouteAbsolute(basePath);
  return `/${encodePathForUrl(normalizedBasePath)}/preview/${encodePathForUrl(absoluteFilePath)}`;
}

export function buildDirectoryUrl(basePath: string): string {
  const normalizedPath = toRouteAbsolute(basePath);
  return `/${encodePathForUrl(normalizedPath)}`;
}

/** @deprecated Use getAbsolutePathFromUrl instead */
export function getFilePathFromUrl(
  basePath: string,
  relativePath?: string,
): string | undefined {
  if (!relativePath) return undefined;
  const decodedBasePath = decodePathFromUrl(basePath);
  const decodedRelativePath = decodePathFromUrl(relativePath);

  const normalizedBasePath = toRouteAbsolute(decodedBasePath);
  return pathutil.join(
    normalizedBasePath,
    pathutil.fromTreePath(decodedRelativePath),
  );
}

/** @deprecated No longer needed with absolute paths */
export function getRelativePathForUrl(
  basePath: string,
  fullPath: string,
): string {
  const normalizedBasePath = toRouteAbsolute(basePath);
  const normalizedFullPath = toRouteAbsolute(fullPath);

  const relativePath = relativeTreePath(normalizedBasePath, normalizedFullPath);
  if (relativePath === undefined) {
    throw new Error(
      `Invalid paths: fullPath "${normalizedFullPath}" must start with basePath "${normalizedBasePath}"`,
    );
  }

  return relativePath;
}
