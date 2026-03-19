/**
 * Normalize a path for use as a workspace identifier.
 * The File System Access API doesn't expose full paths, so we use the folder name.
 * We prefix with '/' to make it look like a Unix path (e.g., "/my-folder").
 */
export function normalizeWorkspacePath(name: string): string {
  // Remove any leading/trailing slashes and re-add a single leading slash
  const cleanName = name.replace(/^\/+|\/+$/g, "");
  return cleanName ? `/${cleanName}` : "/untitled";
}

/**
 * Extract the root workspace name from a full path.
 * For browser FS, the "root" is the first segment (e.g., "/my-folder" from "/my-folder/sub/file.md")
 */
export function getWorkspaceRoot(path: string): string | null {
  const trimmed = path.replace(/^\/+/, "");
  const parts = trimmed.split("/");
  if (!parts[0]) return null;
  return `/${parts[0]}`;
}

/**
 * Get the relative path within a workspace.
 * E.g., for path "/my-folder/docs/file.md" and root "/my-folder", returns "docs/file.md"
 */
export function getRelativePath(path: string, workspaceRoot: string): string {
  if (path === workspaceRoot) return "";
  const prefix = workspaceRoot + "/";
  if (path.startsWith(prefix)) {
    return path.slice(prefix.length);
  }
  return "";
}

/**
 * Check if a path contains hidden segments (starting with ., excluding . and ..)
 */
export function isHiddenPath(path: string): boolean {
  const parts = path.split("/");
  return parts.some(
    (part) => part.startsWith(".") && part.length > 1 && part !== "..",
  );
}

/**
 * Permission modes for File System Access API
 */
export type FsPermissionMode = "read" | "readwrite";

/**
 * Ensure permission is granted for a file system handle.
 * @throws Error if permission is denied
 */
export async function ensurePermission(
  handle: FileSystemDirectoryHandle | FileSystemFileHandle,
  mode: FsPermissionMode,
): Promise<void> {
  const permissionHandle = handle as FileSystemHandle & {
    queryPermission?: (options: {
      mode: FsPermissionMode;
    }) => Promise<PermissionState>;
    requestPermission?: (options: {
      mode: FsPermissionMode;
    }) => Promise<PermissionState>;
  };

  if (
    !permissionHandle.queryPermission ||
    !permissionHandle.requestPermission
  ) {
    return;
  }

  const state = await permissionHandle.queryPermission({ mode });
  if (state === "granted") return;
  const request = await permissionHandle.requestPermission({ mode });
  if (request !== "granted") {
    throw new Error("Permission denied");
  }
}

/**
 * Build an absolute path from workspace root and relative path.
 */
export function buildAbsolutePath(
  workspaceRoot: string,
  relPath: string,
): string {
  const normalizedRoot = workspaceRoot.replace(/\/+$/g, "");
  return relPath ? `${normalizedRoot}/${relPath}` : normalizedRoot;
}
