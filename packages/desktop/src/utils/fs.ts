import { platformAdapter } from "@/adapters";

export interface FileEntry {
  path: string;
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

export function flatEntriesToTree(flatFiles: FileEntries): FileTreeNode[] {
  const pathMap = new Map<string, FileTreeNode>();
  const rootNodes: FileTreeNode[] = [];

  // First pass: Create all directory nodes that might not exist in flatFiles
  // This ensures parent directories exist even if they weren't explicitly added
  const allPaths = Object.keys(flatFiles);
  const directoriesNeeded = new Set<string>();

  allPaths.forEach((path) => {
    const parts = path.split("/").filter((p) => p.length > 0);
    for (let i = 1; i < parts.length; i++) {
      directoriesNeeded.add(parts.slice(0, i).join("/"));
    }
  });

  directoriesNeeded.forEach((dirPath) => {
    if (!flatFiles[dirPath]) {
      const dirNode: FileTreeNode = {
        path: dirPath,
        type: "directory",
        contentHash: "",
        content: "",
        children: [],
      };
      pathMap.set(dirPath, dirNode);
    }
  });

  Object.entries(flatFiles).forEach(([path, entry]) => {
    const node: FileTreeNode = {
      ...entry,
      children: entry.type === "directory" ? [] : undefined,
    };
    pathMap.set(path, node);
  });

  const sortedPaths = Array.from(pathMap.keys()).sort((a, b) => {
    const depthA = a.split("/").filter((p) => p.length > 0).length;
    const depthB = b.split("/").filter((p) => p.length > 0).length;
    return depthA - depthB;
  });

  sortedPaths.forEach((path) => {
    const node = pathMap.get(path)!;
    const parts = path.split("/").filter((p) => p.length > 0);

    if (parts.length === 1) {
      rootNodes.push(node);
    } else {
      const parentPath = parts.slice(0, -1).join("/");
      const parent = pathMap.get(parentPath);

      if (parent && parent.children) {
        parent.children.push(node);
      } else {
        rootNodes.push(node);
      }
    }
  });

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
