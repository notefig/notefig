import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Icons } from "./icons";
import { cn } from "../lib/utils";
import { FileEntry, listAbsoluteDirectory } from "../utils/fs";
import { buildEditFileUrl } from "../utils/routing";

interface DynamicFileTreeProps {
  className?: string;
  selectedPath?: string;
  rootDirectory?: string;
}

export function DynamicFileTree({
  className,
  selectedPath,
  rootDirectory,
}: DynamicFileTreeProps) {
  const navigate = useNavigate();
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

  return (
    <div className={cn("flex flex-col gap-1 text-sm", className)}>
      {files.map((file) => (
        <FileTreeItem
          key={file.path}
          file={file}
          selectedPath={selectedPath}
          rootDirectory={rootDirectory}
          onToggleFolder={toggleFolder}
          isExpanded={expandedFolders.has(file.path)}
          navigate={navigate}
        />
      ))}
    </div>
  );
}

interface FileTreeItemProps {
  file: FileEntry;
  selectedPath?: string;
  rootDirectory?: string;
  onToggleFolder: (path: string) => void;
  isExpanded: boolean;
  navigate: (url: string) => void;
}

function FileTreeItem({
  file,
  selectedPath,
  rootDirectory,
  onToggleFolder,
  isExpanded,
  navigate,
}: FileTreeItemProps) {
  const isSelected = file.path === selectedPath;
  const isFolder = file.isDirectory;

  const Icon = isFolder
    ? isExpanded
      ? Icons.folderOpen
      : Icons.folder
    : getFileIcon(file.name);

  const handleClick = () => {
    if (isFolder) {
      onToggleFolder(file.path);
    } else if (rootDirectory) {
      try {
        const editUrl = buildEditFileUrl(rootDirectory, file.path);
        navigate(editUrl);
      } catch (error) {
        console.error("Error building edit URL:", error);
      }
    }
  };

  return (
    <button
      onClick={handleClick}
      className={cn(
        "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        isSelected &&
          "bg-sidebar-accent text-sidebar-accent-foreground font-medium",
        isFolder && "font-medium text-foreground",
      )}
      title={file.path}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="truncate flex-1">{file.name}</span>
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
