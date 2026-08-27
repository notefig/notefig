import { FsError } from "./platform-adapter.interface";
import type {
  FileSystemError,
  IgnoreRulesOption,
} from "./platform-adapter.interface";

/**
 * Normalize a path for use as a workspace identifier.
 * The File System Access API doesn't expose full paths, so we use the folder name.
 * We prefix with '/' to make it look like a Unix path (e.g., "/my-folder").
 */
export function normalizeWorkspacePath(name: string): string {
  const cleanName = name.replace(/^\/+|\/+$/g, "");
  return cleanName ? `/${cleanName}` : "/untitled";
}

function normalizePathSegments(path: string): string {
  const hasLeadingSlash = path.startsWith("/");
  const segments = path.split("/");
  const normalized: string[] = [];

  for (const segment of segments) {
    if (!segment || segment === ".") {
      continue;
    }

    if (segment === "..") {
      if (normalized.length > 0) {
        normalized.pop();
      }
      continue;
    }

    normalized.push(segment);
  }

  const joined = normalized.join("/");
  if (!joined) {
    return hasLeadingSlash ? "/" : "";
  }

  return hasLeadingSlash ? `/${joined}` : joined;
}

/**
 * Extract the root workspace name from a full path.
 * For browser FS, the "root" is the first segment (e.g., "/my-folder" from "/my-folder/sub/file.md")
 */
export function getWorkspaceRoot(path: string): string | null {
  const normalizedPath = normalizePathSegments(path);
  const trimmed = normalizedPath.replace(/^\/+/, "");
  const parts = trimmed.split("/");
  if (!parts[0]) return null;
  return `/${parts[0]}`;
}

/**
 * Get the relative path within a workspace.
 * E.g., for path "/my-folder/docs/file.md" and root "/my-folder", returns "docs/file.md"
 */
export function getRelativePath(path: string, workspaceRoot: string): string {
  const normalizedPath = normalizePathSegments(path);
  const normalizedRoot = normalizePathSegments(workspaceRoot);

  if (normalizedPath === normalizedRoot) return "";
  const prefix = normalizedRoot + "/";
  if (normalizedPath.startsWith(prefix)) {
    return normalizedPath.slice(prefix.length);
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

/** Read-directory options with the browser adapters' shared defaults. */
export function resolveReadDirectoryOptions(options?: {
  recursive?: boolean;
  includeFiles?: boolean;
  includeDirectories?: boolean;
  includeHidden?: boolean;
  allowHiddenDirectories?: string[];
}): {
  recursive: boolean;
  includeFiles: boolean;
  includeDirectories: boolean;
  includeHidden: boolean;
  allowHiddenDirectories: string[];
} {
  return {
    recursive: options?.recursive ?? false,
    includeFiles: options?.includeFiles !== false,
    includeDirectories: options?.includeDirectories !== false,
    includeHidden: options?.includeHidden ?? false,
    allowHiddenDirectories: options?.allowHiddenDirectories ?? [],
  };
}

/**
 * Hidden check with per-component allowances (MET-135): a dot component in
 * `allowNames` (e.g. ".metrists") passes, but other hidden components —
 * including hidden children of an allowed one — still hide the path.
 * Mirrors the native walker's allow_hidden_names semantics.
 */
export function isHiddenPathAllowing(
  path: string,
  allowNames: readonly string[],
): boolean {
  return path
    .split("/")
    .some(
      (part) =>
        part.startsWith(".") &&
        part.length > 1 &&
        part !== ".." &&
        !allowNames.includes(part),
    );
}

/**
 * App-side ignore checks for browser adapters. Lists arrive lowercased
 * from utils/ignore.ts via the opt-in `ignore` option — callers that need
 * the complete tree (the git storage host) never pass it.
 */
export function isIgnoredName(
  name: string,
  ignore: IgnoreRulesOption,
): boolean {
  return ignore.directories.includes(name.toLowerCase());
}

export function hasIgnoredExtension(
  name: string,
  ignore: IgnoreRulesOption,
): boolean {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return false;
  return ignore.extensions.includes(name.slice(dot + 1).toLowerCase());
}

/** Whether a path (relative to the listing root) matches the ignore rules. */
export function matchesIgnoreRules(
  relativePath: string,
  ignore?: IgnoreRulesOption,
): boolean {
  if (!ignore) return false;
  const parts = relativePath.split("/").filter((p) => p.length > 0);
  if (parts.length === 0) return false;
  if (parts.some((p) => isIgnoredName(p, ignore))) return true;
  return hasIgnoredExtension(parts[parts.length - 1], ignore);
}

/**
 * A per-entry ignore predicate for directory walks. Built once per listing
 * so the walk body stays a single branch (and costs nothing when the
 * caller opted out of filtering, e.g. the git storage host).
 */
export function createEntryIgnoreFilter(
  ignore?: IgnoreRulesOption,
): (name: string, isFile: boolean) => boolean {
  if (!ignore) return () => false;
  return (name, isFile) =>
    isIgnoredName(name, ignore) ||
    (isFile && hasIgnoredExtension(name, ignore));
}

/**
 * Permission modes for File System Access API
 */
export type FsPermissionMode = "read" | "readwrite";

type PermissionCapableHandle = FileSystemHandle & {
  queryPermission?: (options: {
    mode: FsPermissionMode;
  }) => Promise<PermissionState>;
  requestPermission?: (options: {
    mode: FsPermissionMode;
  }) => Promise<PermissionState>;
};

/**
 * Query the current permission state without prompting.
 * Handles without the permission API report "granted".
 */
export async function queryPermissionState(
  handle: FileSystemDirectoryHandle | FileSystemFileHandle,
  mode: FsPermissionMode,
): Promise<PermissionState> {
  const permissionHandle = handle as PermissionCapableHandle;
  if (!permissionHandle.queryPermission) return "granted";
  return permissionHandle.queryPermission({ mode });
}

/**
 * Actively request permission — MUST run inside a user gesture (Chrome
 * rejects requestPermission without user activation).
 * Handles without the permission API report "granted".
 */
export async function requestPermissionState(
  handle: FileSystemDirectoryHandle | FileSystemFileHandle,
  mode: FsPermissionMode,
): Promise<PermissionState> {
  const permissionHandle = handle as PermissionCapableHandle;
  if (!permissionHandle.requestPermission) return "granted";
  return permissionHandle.requestPermission({ mode });
}

/**
 * Turn a thrown browser fs error into a typed FileSystemError.
 */
export function classifyBrowserError(
  path: string,
  error: unknown,
): FileSystemError {
  if (error instanceof FsError) return error;
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError") {
      return new FsError("permission_denied", path, error.message);
    }
    if (error.name === "NotFoundError") {
      return new FsError("not_found", path, error.message);
    }
  }
  return new FsError(
    "io_error",
    path,
    error instanceof Error ? error.message : "Unknown error",
  );
}

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
    throw new FsError("permission_denied", handle.name);
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
