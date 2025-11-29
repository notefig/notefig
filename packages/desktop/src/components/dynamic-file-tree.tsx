import { useState, useEffect } from "react";
import { Icons } from "./icons";
import { cn } from "../lib/utils";
import { FileEntry, listAbsoluteDirectory } from "../utils/fs";
import { useFileManager } from "@/hooks/useFileManager";

interface DynamicFileTreeProps {
  className?: string;
  rootDirectory?: string;
}

export function DynamicFileTree({
  className,
  rootDirectory,
}: DynamicFileTreeProps) {
  const { openTab, activeFilePath, tabs } = useFileManager();
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
    new Set(),
  );

  useEffect(() => {
    if (rootDirectory) {
      loadDirectory(rootDirectory);
    }
  }, [rootDirectory]);

  const loadDirectory = async (path: string) => {
    setLoading(true);
    try {
      const entries = await listAbsoluteDirectory(path, false);
      // Sort: directories first, then files, both alphabetically
      const sorted = entries.sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;
        return a.name.localeCompare(b.name);
      });
      setFiles(sorted);
    } catch (error) {
      console.error("Failed to load directory:", error);
      setFiles([]);
    } finally {
      setLoading(false);
    }
  };

  const toggleFolder = async (path: string) => {
    const newExpanded = new Set(expandedFolders);

    if (expandedFolders.has(path)) {
      newExpanded.delete(path);
    } else {
      newExpanded.add(path);
      // For now, we just track expanded state
      // In a full implementation, you'd load subdirectory contents here
    }

    setExpandedFolders(newExpanded);
  };

  if (!rootDirectory) {
    return (
      <div
        className={cn(
          "flex flex-col items-center justify-center p-8 text-center",
          className,
        )}
      >
        <Icons.folder className="h-12 w-12 text-muted-foreground mb-4" />
        <p className="text-sm text-muted-foreground">No directory selected</p>
        <p className="text-xs text-muted-foreground mt-2">
          Use "Open Folder" to browse files
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className={cn("flex items-center justify-center p-8", className)}>
        <div className="animate-spin">
          <Icons.folder className="h-6 w-6 text-muted-foreground" />
        </div>
      </div>
    );
  }

  // Get list of all open tab file paths for highlighting
  const openTabPaths = tabs.map((tab) => tab.filePath);

  return (
    <div className={cn("flex flex-col gap-1 text-sm", className)}>
      {files.map((file) => (
        <FileTreeItem
          key={file.path}
          file={file}
          selectedPath={activeFilePath || undefined}
          openTabPaths={openTabPaths}
          onToggleFolder={toggleFolder}
          isExpanded={expandedFolders.has(file.path)}
          onFileSelect={openTab}
        />
      ))}
    </div>
  );
}

interface FileTreeItemProps {
  file: FileEntry;
  selectedPath?: string;
  openTabPaths: string[];
  onToggleFolder: (path: string) => void;
  isExpanded: boolean;
  onFileSelect: (filePath: string) => Promise<void>;
}

function FileTreeItem({
  file,
  selectedPath,
  openTabPaths,
  onToggleFolder,
  isExpanded,
  onFileSelect,
}: FileTreeItemProps) {
  const isSelected = file.path === selectedPath;
  const isFolder = file.isDirectory;

  // Check if this file is open in a tab (but not necessarily active)
  const isOpenInTab = !isFolder && openTabPaths.includes(file.path);

  // Check if this file is the currently active tab
  const isActiveTab = isSelected && isOpenInTab;

  const Icon = isFolder
    ? isExpanded
      ? Icons.folderOpen
      : Icons.folder
    : getFileIcon(file.name);

  const handleClick = () => {
    if (isFolder) {
      onToggleFolder(file.path);
    } else {
      onFileSelect(file.path);
    }
  };

  return (
    <button
      onClick={handleClick}
      className={cn(
        "flex items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
        // Base styles for files and folders
        isFolder
          ? "font-medium text-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          : "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",

        // Active tab styling (most prominent)
        isActiveTab && [
          "bg-sidebar-accent text-sidebar-accent-foreground font-medium",
          "ring-1 ring-primary/50 border-l-2 border-l-primary",
        ],

        // Open tab styling (subtle highlighting)
        isOpenInTab &&
          !isActiveTab && [
            "bg-sidebar-accent/50 text-sidebar-accent-foreground/80 font-medium",
          ],

        // Regular selected file (when not in a tab)
        isSelected &&
          !isOpenInTab && [
            "bg-sidebar-accent text-sidebar-accent-foreground font-medium",
          ],
      )}
      title={file.path}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="truncate flex-1">{file.name}</span>

      {/* Small indicator dot for open tabs */}
      {isOpenInTab && !isFolder && (
        <div
          className={cn(
            "h-1.5 w-1.5 rounded-full shrink-0 ml-1",
            isActiveTab ? "bg-primary" : "bg-primary/60",
          )}
          title={isActiveTab ? "Active tab" : "Open in tab"}
        />
      )}
      {isFolder && (
        <Icons.chevronRight
          className={cn(
            "ml-auto h-3.5 w-3.5 shrink-0 transition-transform",
            isExpanded && "rotate-90",
          )}
        />
      )}
      {!isFolder && file.size !== undefined && (
        <span className="text-xs text-muted-foreground shrink-0">
          {formatFileSize(file.size)}
        </span>
      )}
    </button>
  );
}

function getFileIcon(filename: string) {
  const ext = filename.split(".").pop()?.toLowerCase();

  switch (ext) {
    case "md":
    case "markdown":
      return Icons.fileText;
    case "ts":
    case "tsx":
    case "js":
    case "jsx":
      return Icons.fileCode;
    case "json":
      return Icons.fileCode;
    case "txt":
      return Icons.fileText;
    default:
      return Icons.file;
  }
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B";

  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}
