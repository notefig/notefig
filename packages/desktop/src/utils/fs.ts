import { platformAdapter } from "@/adapters";

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

/**
 * Extended FileEntry interface for tree structure representation
 * Adds children array for hierarchical display and optional UI properties
 */
export interface FileTreeNode extends FileEntry {
  children?: FileTreeNode[];
  label?: string;
}

/**
 * Get the file or directory name from a file path
 */
export function getFileName(filePath: string): string {
  if (!filePath) return "";
  const parts = filePath.split("/").filter((p) => p.length > 0);
  return parts.length > 0 ? parts[parts.length - 1] : filePath;
}

/**
 * Get the file extension from a file path
 */
export function getFileExtension(filePath: string): string {
  const parts = filePath.split(".");
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : "";
}

/**
 * Check if a file is a text file that can be edited in the text editor.
 * This excludes binary files like images, videos, PDFs, etc.
 */
export function isTextFile(filePath: string): boolean {
  const extension = getFileExtension(filePath);

  // Common text file extensions
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

/**
 * Get the file name without extension from a file path
 */
export function getFileNameWithoutExtension(filePath: string): string {
  const fileName = filePath.split("/").pop() || filePath;
  const parts = fileName.split(".");
  return parts.length > 1 ? parts.slice(0, -1).join(".") : fileName;
}

/**
 * Get the directory path from a file path
 */
export function getDirectoryPath(filePath: string): string {
  const parts = filePath.split("/");
  return parts.slice(0, -1).join("/") || "/";
}

/**
 * Join path components
 */
export function joinPaths(...paths: string[]): string {
  return paths
    .filter((path) => path && path.length > 0)
    .map((path) => path.replace(/^\/+|\/+$/g, ""))
    .join("/")
    .replace(/\/+/g, "/");
}

/**
 * Normalize a file path by ensuring it starts with a leading slash
 * and removing duplicate slashes and trailing slashes
 */
export function normalizePath(filePath: string): string {
  if (!filePath) return "/";

  let normalized = filePath
    .replace(/\\/g, "/") // Convert backslashes to forward slashes
    .replace(/\/+/g, "/"); // Remove duplicate slashes

  // Ensure leading slash
  if (!normalized.startsWith("/")) {
    normalized = "/" + normalized;
  }

  // Remove trailing slash unless it's the root
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }

  return normalized;
}

export function flatEntriesToTree(
  flatFiles: FileEntries,
  basePath: string,
): FileTreeNode[] {
  const pathMap = new Map<string, FileTreeNode>();
  const rootNodes: FileTreeNode[] = [];

  // Normalize basePath for comparison
  const normalizedBasePath = normalizePath(basePath);

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

  // Create missing directory nodes
  directoriesNeeded.forEach((relPath) => {
    const absolutePath = `${normalizedBasePath}/${relPath}`;
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

  // Add all existing file entries
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
      // Top-level entry
      rootNodes.push(node);
    } else {
      // Nested entry - find parent
      const parentRelativePath = parts.slice(0, -1).join("/");
      const parentAbsolutePath = `${normalizedBasePath}/${parentRelativePath}`;
      const parent = pathMap.get(parentAbsolutePath);

      if (parent && parent.children) {
        parent.children.push(node);
      } else {
        // Parent not found, add to root (shouldn't happen but be safe)
        rootNodes.push(node);
      }
    }
  });

  // Sort children: directories first, then alphabetically
  const sortChildren = (nodes: FileTreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.type === "directory" && b.type === "file") return -1;
      if (a.type === "file" && b.type === "directory") return 1;

      const nameA = getFileName(a.path).toLowerCase();
      const nameB = getFileName(b.path).toLowerCase();
      return nameA.localeCompare(nameB);
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
 * Opens a directory picker dialog
 * Delegates to the platform adapter for platform-specific implementation
 * @param title - Optional title for the picker dialog
 * @returns Promise that resolves to the selected directory path or null if cancelled
 */
export async function pickDirectory(title: string): Promise<string | null> {
  return platformAdapter.pickDirectory(title);
}
