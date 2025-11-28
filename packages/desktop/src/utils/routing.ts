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

  // Ensure proper path joining with leading slash
  const normalizedBasePath = decodedBasePath.startsWith("/")
    ? decodedBasePath
    : "/" + decodedBasePath;
  return `${normalizedBasePath}/${decodedRelativePath}`;
}

export function getRelativePathForUrl(
  basePath: string,
  fullPath: string,
): string {
  // Normalize both paths to ensure consistent comparison
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

export function buildDirectoryUrl(basePath: string): string {
  // Ensure we maintain the leading slash in the path
  const normalizedPath = basePath.startsWith("/") ? basePath : "/" + basePath;
  return `/${encodePathForUrl(normalizedPath)}`;
}

export function buildEditFileUrl(
  basePath: string,
  fullFilePath: string,
): string {
  // Ensure we maintain the leading slash in the base path
  const normalizedBasePath = basePath.startsWith("/")
    ? basePath
    : "/" + basePath;
  const relativePath = getRelativePathForUrl(basePath, fullFilePath);
  return `/${encodePathForUrl(normalizedBasePath)}/edit/${encodePathForUrl(relativePath)}`;
}

export function buildPreviewFileUrl(
  basePath: string,
  fullFilePath: string,
): string {
  // Ensure we maintain the leading slash in the base path
  const normalizedBasePath = basePath.startsWith("/")
    ? basePath
    : "/" + basePath;
  const relativePath = getRelativePathForUrl(basePath, fullFilePath);
  return `/${encodePathForUrl(normalizedBasePath)}/preview/${encodePathForUrl(relativePath)}`;
}
