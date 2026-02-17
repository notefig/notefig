import { useMemo, useState, useCallback } from "react";
import {
  FileText,
  Folder,
  FolderOpen,
  ChevronRight,
  ChevronDown,
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  FileTreeNode,
  flatEntriesToTree,
  getFileName,
  type FileEntries,
} from "@/utils/fs";
import {
  getOrCreateWorkspaceCollections,
  prefetchFileContent,
} from "@/utils/collections";
import { useLiveQuery } from "@tanstack/react-db";

interface FileTreeProps {
  selectedFilePath: string | null;
  onFileSelect: (file: FileTreeNode) => void;
  basePath: string;
}

interface FileTreeItemProps {
  node: FileTreeNode;
  depth: number;
  selectedFilePath: string | null;
  onFileSelect: (file: FileTreeNode) => void;
  onFileHover?: (filePath: string) => void;
}

function FileTreeItem({
  node,
  depth,
  selectedFilePath,
  onFileSelect,
  onFileHover,
}: FileTreeItemProps) {
  const [isExpanded, setIsExpanded] = useState(true);

  const handleClick = () => {
    if (node.type === "directory") {
      setIsExpanded(!isExpanded);
    } else {
      onFileSelect(node);
    }
  };

  const handleMouseEnter = () => {
    if (node.type === "file" && onFileHover) {
      onFileHover(node.path);
    }
  };

  const paddingValue = depth * 12 + 8;
  const name = getFileName(node.path);

  return (
    <div>
      <button
        onClick={handleClick}
        onMouseEnter={handleMouseEnter}
        className={cn(
          "w-full flex items-center gap-1 px-2 py-1 text-sm hover:bg-accent/50 transition-colors",
          selectedFilePath === node.path && node.type === "file" && "bg-accent",
        )}
        style={{
          paddingInlineStart: `${paddingValue}px`,
          paddingInlineEnd: "8px",
        }}
      >
        {/* Icons and name container - reverses in RTL */}
        <div className="flex items-center gap-1 flex-1 min-w-0">
          {node.type === "directory" ? (
            <>
              {isExpanded ? (
                <ChevronDown className="w-4 h-4 shrink-0 text-muted-foreground rtl:-scale-x-100" />
              ) : (
                <ChevronRight className="w-4 h-4 shrink-0 text-muted-foreground rtl:-scale-x-100" />
              )}
              {isExpanded ? (
                <FolderOpen className="w-4 h-4 shrink-0 text-muted-foreground" />
              ) : (
                <Folder className="w-4 h-4 shrink-0 text-muted-foreground" />
              )}
            </>
          ) : (
            <>
              <span className="w-4 shrink-0" />
              <FileText className="w-4 h-4 shrink-0 text-muted-foreground" />
            </>
          )}
          <span className="truncate text-foreground">{name}</span>
        </div>
        <span className="shrink-0 text-xs text-muted-foreground uppercase tracking-wider"></span>
      </button>
      {node.type === "directory" && isExpanded && node.children && (
        <div>
          {node.children.map((child) => (
            <FileTreeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedFilePath={selectedFilePath}
              onFileSelect={onFileSelect}
              onFileHover={onFileHover}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function FileTree({
  selectedFilePath,
  onFileSelect,
  basePath,
}: FileTreeProps) {
  const { metadata } = getOrCreateWorkspaceCollections(basePath);

  const handleFileHover = useCallback(
    (filePath: string) => {
      prefetchFileContent(basePath, filePath).catch((error: unknown) => {
        console.debug(`Failed to prefetch ${filePath}:`, error);
      });
    },
    [basePath],
  );

  // Query all file metadata entries
  const { data: fileMetadataList = [] } = useLiveQuery((q) =>
    q.from({ file: metadata }).select(({ file }) => ({
      path: file.path,
      relativePath: file.relativePath,
      type: file.type,
      modified: file.modified,
      size: file.size,
      contentHash: file.contentHash,
      error: file.error,
    })),
  );

  const files: FileEntries = useMemo(() => {
    return fileMetadataList.reduce((acc, entry) => {
      acc[entry.path] = {
        ...entry,
        content: "", // Metadata doesn't include content
      };
      return acc;
    }, {} as FileEntries);
  }, [fileMetadataList]);

  const filesTree = useMemo(() => {
    return flatEntriesToTree(files, basePath);
  }, [files, basePath]);

  return (
    <ScrollArea className="h-full w-full">
      <div className="py-1">
        {filesTree.map((node) => (
          <FileTreeItem
            key={node.path}
            node={node}
            depth={0}
            selectedFilePath={selectedFilePath}
            onFileSelect={onFileSelect}
            onFileHover={handleFileHover}
          />
        ))}
      </div>
    </ScrollArea>
  );
}
