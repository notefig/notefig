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

export function buildEditFileUrl(
  basePath: string,
  absoluteFilePath: string,
): string {
  const normalizedBasePath = basePath.startsWith("/")
    ? basePath
    : "/" + basePath;
  return `/${encodePathForUrl(normalizedBasePath)}/edit/${encodePathForUrl(absoluteFilePath)}`;
}

export function buildPreviewFileUrl(
  basePath: string,
  absoluteFilePath: string,
): string {
  const normalizedBasePath = basePath.startsWith("/")
    ? basePath
    : "/" + basePath;
  return `/${encodePathForUrl(normalizedBasePath)}/preview/${encodePathForUrl(absoluteFilePath)}`;
}

export function buildDirectoryUrl(basePath: string): string {
  const normalizedPath = basePath.startsWith("/") ? basePath : "/" + basePath;
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

  const normalizedBasePath = decodedBasePath.startsWith("/")
    ? decodedBasePath
    : "/" + decodedBasePath;
  return `${normalizedBasePath}/${decodedRelativePath}`;
}

/** @deprecated No longer needed with absolute paths */
export function getRelativePathForUrl(
  basePath: string,
  fullPath: string,
): string {
  const normalizedBasePath = basePath.startsWith("/")
    ? basePath
    : "/" + basePath;
  const normalizedFullPath = fullPath.startsWith("/")
    ? fullPath
    : "/" + fullPath;

  if (!normalizedFullPath.startsWith(normalizedBasePath)) {
    throw new Error(
      `Invalid paths: fullPath "${normalizedFullPath}" must start with basePath "${normalizedBasePath}"`,
    );
  }

  const relativePath = normalizedFullPath.slice(normalizedBasePath.length);
  return relativePath.startsWith("/") ? relativePath.slice(1) : relativePath;
}
