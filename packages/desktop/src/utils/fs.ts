import { platformAdapter } from "@/adapters";
import type { TextPromptOptions } from "@/adapters/platform-adapter.interface";
import { path as pathutil } from "./path";

export interface FileEntry {
  path: string; // Absolute path
  relativePath?: string; // Relative path to basePath (optional - not all files are inside basePath)
  type: "file" | "directory";
  modified?: Date;
  size?: number;
  contentHash: string;
  content: string;
  error?: string;
}

export type FileEntries = Record<FileEntry["path"], FileEntry>;

export type SortOrder = "name-asc" | "name-desc" | "date-modified";

export interface FileTreeNode extends FileEntry {
  children?: FileTreeNode[];
  label?: string;
}

export function getFileName(filePath: string): string {
  if (!filePath) return "";
  return pathutil.basename(filePath) || filePath;
}

export function getFileExtension(filePath: string): string {
  const parts = filePath.split(".");
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : "";
}

const imageExtensions = new Set([
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "svg",
  "bmp",
  "ico",
]);

/** Whether a path is an image by extension (viewer/insertable image). */
export function isImageFile(filePath: string): boolean {
  return imageExtensions.has(getFileExtension(filePath));
}

/**
 * Check if a file is a text file that can be edited in the text editor.
 * This excludes binary files like images, videos, PDFs, etc.
 */
export function isTextFile(filePath: string): boolean {
  const extension = getFileExtension(filePath);

  const textExtensions = new Set([
    // Markdown
    "md",
    "markdown",
    "mdown",
    "mkd",
    // Plain text
    "txt",
    "text",
    // Code
    "js",
    "jsx",
    "ts",
    "tsx",
    "json",
    "html",
    "css",
    "scss",
    "sass",
    "py",
    "rb",
    "java",
    "c",
    "cpp",
    "h",
    "hpp",
    "cs",
    "go",
    "rs",
    "php",
    "swift",
    "kt",
    "dart",
    "scala",
    "sh",
    "bash",
    "zsh",
    // Config/data
    "yaml",
    "yml",
    "toml",
    "xml",
    "ini",
    "conf",
    "config",
    // Documentation
    "rst",
    "adoc",
    "asciidoc",
    "org",
    // Other
    "log",
    "csv",
    "tsv",
    "sql",
  ]);

  // If no extension, assume it might be a text file (like README, Makefile, etc.)
  if (!extension) return true;

  return textExtensions.has(extension);
}

export function getFileNameWithoutExtension(filePath: string): string {
  const fileName = pathutil.basename(filePath) || filePath;
  const parts = fileName.split(".");
  return parts.length > 1 ? parts.slice(0, -1).join(".") : fileName;
}

export function getDirectoryPath(filePath: string): string {
  const dir = pathutil.dirname(filePath);
  return dir === "." ? "/" : dir;
}

export function joinPaths(...paths: string[]): string {
  return paths
    .filter((path) => path && path.length > 0)
    .map((path) => path.replace(/^\/+|\/+$/g, ""))
    .join("/")
    .replace(/\/+/g, "/");
}

// normalizePath is gone (MET-157 B2): its "/"-prepend corrupted native
// Windows paths, and every caller migrated to `path.normalize` (spelling),
// `workspaceKey` (registry/persisted keys), or `relativeTreePath`
// (derivations) in @/utils/path. For real mac inputs all of these produce
// byte-identical output, so persisted keys never changed spelling.

export type WorkspacePathResolution =
  | { ok: true; absolute: string; relative: string }
  | { ok: false; error: string };

/**
 * Resolve an agent-supplied document path against a workspace root, errors
 * as values. Agents send workspace-relative paths ("notes.md" — the tool
 * schemas ask for them) but sometimes absolute ones; both are accepted, and
 * the result is always `{ absolute, relative }` with containment enforced —
 * `..` escapes and absolute paths outside the workspace are rejected.
 *
 * This exists because an unresolved relative path reaches the OS resolved
 * against the *process CWD* — under `cargo tauri dev` that's `src-tauri/`,
 * so an agent authoring "canto-ii.md" wrote into the app's own source tree
 * and the dev watcher restarted the app on every question.
 */
export function resolveWorkspacePath(
  workspacePath: string,
  inputPath: string,
): WorkspacePathResolution {
  const root = pathutil.normalize(workspacePath);
  // Agent-supplied relative paths are "/"-separated (the tool schemas'
  // contract) — tree-domain, converted to native before joining.
  const joined = pathutil.isAbsolute(inputPath)
    ? pathutil.normalize(inputPath)
    : pathutil.join(root, pathutil.fromTreePath(inputPath));

  // Collapse "." and ".." segments so escapes are caught structurally, in
  // forward-slash space so one loop serves both flavors. The filesystem-root
  // segments can never be popped:
  //   posix  /a/b        → [""]        win32  C:/a → ["C:"]
  //   UNC    //srv/sh/a  → ["", "", "srv", "sh"]
  const posixForm = pathutil.toPosixAbsolute(joined);
  const parts = posixForm.split("/");
  const rootCount = posixForm.startsWith("//") ? 4 : 1;
  const kept = parts.slice(0, rootCount);
  const segments: string[] = [];
  for (const segment of parts.slice(rootCount)) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) {
        return { ok: false, error: `path escapes the workspace: ${inputPath}` };
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  const absolute = pathutil.normalize([...kept, ...segments].join("/"));

  const relativeNative = pathutil.relative(root, absolute);
  if (relativeNative === undefined) {
    return {
      ok: false,
      error: `path is outside the workspace (${workspacePath}): ${inputPath}`,
    };
  }
  // The relative half stays "/"-separated: every consumer (tool results,
  // metadata rows, tree paths) lives in the tree-path domain.
  return { ok: true, absolute, relative: pathutil.toTreePath(relativeNative) };
}

export function flatEntriesToTree(
  flatFiles: FileEntries,
  basePath: string,
  sortOrder: SortOrder = "name-asc",
): FileTreeNode[] {
  const pathMap = new Map<string, FileTreeNode>();
  const rootNodes: FileTreeNode[] = [];

  // relativePath is tree-domain ("/"-separated on every platform); absolute
  // node paths are native and must match the callers' row-key spelling.
  const normalizedBasePath = pathutil.normalize(basePath);

  // First pass: Create all directory nodes that might not exist in flatFiles
  // This ensures parent directories exist even if they weren't explicitly added
  // We work with relativePath for tree structure
  const allRelativePaths = Object.values(flatFiles)
    .map((entry) => entry.relativePath)
    .filter((rp): rp is string => rp !== undefined);

  const directoriesNeeded = new Set<string>();

  allRelativePaths.forEach((relativePath) => {
    const parts = relativePath.split("/").filter((p) => p.length > 0);
    for (let i = 1; i < parts.length; i++) {
      directoriesNeeded.add(parts.slice(0, i).join("/"));
    }
  });

  directoriesNeeded.forEach((relPath) => {
    const absolutePath = pathutil.join(
      normalizedBasePath,
      pathutil.fromTreePath(relPath),
    );
    if (!flatFiles[absolutePath]) {
      const dirNode: FileTreeNode = {
        path: absolutePath,
        relativePath: relPath,
        type: "directory",
        contentHash: "",
        content: "",
        children: [],
      };
      pathMap.set(absolutePath, dirNode);
    }
  });

  Object.entries(flatFiles).forEach(([absolutePath, entry]) => {
    const node: FileTreeNode = {
      ...entry,
      path: absolutePath,
      children: entry.type === "directory" ? [] : undefined,
    };
    pathMap.set(absolutePath, node);
  });

  // Sort by relative path depth for hierarchical processing
  const sortedEntries = Array.from(pathMap.values()).sort((a, b) => {
    const depthA = (a.relativePath || "")
      .split("/")
      .filter((p) => p.length > 0).length;
    const depthB = (b.relativePath || "")
      .split("/")
      .filter((p) => p.length > 0).length;
    return depthA - depthB;
  });

  sortedEntries.forEach((node) => {
    if (!node.relativePath) {
      // Files without relativePath (outside workspace) - skip for now
      return;
    }

    const parts = node.relativePath.split("/").filter((p) => p.length > 0);

    if (parts.length === 1) {
      rootNodes.push(node);
    } else {
      const parentRelativePath = parts.slice(0, -1).join("/");
      const parentAbsolutePath = pathutil.join(
        normalizedBasePath,
        pathutil.fromTreePath(parentRelativePath),
      );
      const parent = pathMap.get(parentAbsolutePath);

      if (parent && parent.children) {
        parent.children.push(node);
      } else {
        // Parent not found, add to root (shouldn't happen but be safe)
        rootNodes.push(node);
      }
    }
  });

  const sortChildren = (nodes: FileTreeNode[]) => {
    nodes.sort((a, b) => {
      switch (sortOrder) {
        case "name-asc": {
          const nameA = getFileName(a.path).toLowerCase();
          const nameB = getFileName(b.path).toLowerCase();
          return nameA.localeCompare(nameB);
        }
        case "name-desc": {
          const nameA = getFileName(a.path).toLowerCase();
          const nameB = getFileName(b.path).toLowerCase();
          return nameB.localeCompare(nameA);
        }
        case "date-modified": {
          const timeA = a.modified ? new Date(a.modified).getTime() : 0;
          const timeB = b.modified ? new Date(b.modified).getTime() : 0;
          return timeB - timeA; // Newest first
        }
        default:
          return 0;
      }
    });

    nodes.forEach((node) => {
      if (node.children && node.children.length > 0) {
        sortChildren(node.children);
      }
    });
  };

  sortChildren(rootNodes);

  return rootNodes;
}

/**
 * Validate a new file/directory name.
 * Returns an error message string, or null if valid.
 */
export function validateFileName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "Name cannot be empty";
  if (trimmed.includes("/") || trimmed.includes("\\"))
    return "Name cannot contain / or \\";
  if (trimmed === "." || trimmed === "..") return "Name cannot be . or ..";
  return null;
}

/**
 * Ensure a newly created file name has an extension.
 * If no extension is present, defaults to `.md`.
 */
export function ensureNewFileNameHasDefaultMarkdownExtension(
  fileName: string,
): string {
  if (fileName.length === 0) return fileName;

  if (fileName.endsWith(".")) {
    const withoutTrailingDots = fileName.replace(/\.+$/, "");
    return withoutTrailingDots.length > 0
      ? `${withoutTrailingDots}.md`
      : fileName;
  }

  const lastDotIndex = fileName.lastIndexOf(".");
  const hasExtension = lastDotIndex >= 0 && lastDotIndex < fileName.length - 1;

  if (hasExtension) return fileName;

  return `${fileName}.md`;
}

export async function pickDirectory(title: string): Promise<string | null> {
  return platformAdapter.ui.pickDirectory(title);
}

export async function promptText(
  options: TextPromptOptions,
): Promise<string | null> {
  return platformAdapter.ui.promptText(options);
}
