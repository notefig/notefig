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

export function getFilePathFromUrl(
  basePath: string,
  relativePath?: string,
): string | undefined {
  if (!relativePath) return undefined;
  const decodedBasePath = decodePathFromUrl(basePath);
  const decodedRelativePath = decodePathFromUrl(relativePath);

  return `${decodedBasePath}/${decodedRelativePath}`;
}

export function getRelativePathForUrl(
  basePath: string,
  fullPath: string,
): string {
  if (!basePath || !fullPath.startsWith(basePath)) {
    throw new Error(
      `Invalid paths: fullPath "${fullPath}" must start with basePath "${basePath}"`,
    );
  }

  const relativePath = fullPath.slice(basePath.length);
  return relativePath.startsWith("/") ? relativePath.slice(1) : relativePath;
}

export function buildDirectoryUrl(basePath: string): string {
  return `/${encodePathForUrl(basePath)}`;
}

export function buildEditFileUrl(
  basePath: string,
  fullFilePath: string,
): string {
  const relativePath = getRelativePathForUrl(basePath, fullFilePath);
  return `/${encodePathForUrl(basePath)}/edit/${encodePathForUrl(relativePath)}`;
}

export function buildPreviewFileUrl(
  basePath: string,
  fullFilePath: string,
): string {
  const relativePath = getRelativePathForUrl(basePath, fullFilePath);
  return `/${encodePathForUrl(basePath)}/preview/${encodePathForUrl(relativePath)}`;
}
