import { useMemo, useState, useCallback, useRef, useEffect, memo } from "react";
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
  getFileExtension,
  validateFileName,
  type FileEntries,
  type SortOrder,
} from "@/utils/fs";
import {
  getOrCreateWorkspaceCollections,
  prefetchFileContent,
} from "@/utils/collections";
import { useLiveQuery } from "@tanstack/react-db";
import { FileTreeContextMenu } from "./file-tree-context-menu";

interface FileTreeProps {
  selectedFilePath: string | null;
  onFileSelect: (file: FileTreeNode) => void;
  onDelete?: (path: string) => void;
  onRename?: (oldPath: string, newName: string) => void;
  openTabs?: string[];
  basePath: string;
  sortOrder?: SortOrder;
}

interface FileTreeItemProps {
  node: FileTreeNode;
  depth: number;
  selectedFilePath: string | null;
  onFileSelect: (file: FileTreeNode) => void;
  onFileHover?: (filePath: string) => void;
  onDelete?: (path: string) => void;
  onRename?: (oldPath: string, newName: string) => void;
  renamingPath: string | null;
  onRenamingPathChange: (path: string | null) => void;
  openTabs?: string[];
}

/**
 * Isolated rename input component.
 * Manages its own value state and uses a committed ref to prevent
 * double-submission (e.g. blur firing after Enter or Escape).
 */
interface RenameInputProps {
  initialName: string;
  fileType: "file" | "directory";
  filePath: string;
  onSubmit: (newName: string) => void;
  onCancel: () => void;
}

const RenameInput = memo(function RenameInput({
  initialName,
  fileType,
  filePath,
  onSubmit,
  onCancel,
}: RenameInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const committedRef = useRef(false);
  // Guard against premature blur caused by the context menu's focus-restore
  // racing with our autoFocus. Becomes true after a short delay.
  const readyRef = useRef(false);

  useEffect(() => {
    const timerId = setTimeout(() => {
      readyRef.current = true;
    }, 150);

    // Select the appropriate text range once mounted.
    const rafId = requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      if (fileType === "file") {
        const ext = getFileExtension(filePath);
        const nameWithoutExt = ext
          ? initialName.slice(0, -(ext.length + 1))
          : initialName;
        input.setSelectionRange(0, nameWithoutExt.length);
      } else {
        input.select();
      }
    });

    return () => {
      clearTimeout(timerId);
      cancelAnimationFrame(rafId);
    };
  }, []); // Only on mount

  const commit = useCallback(
    (value: string) => {
      if (committedRef.current) return;
      committedRef.current = true;

      const trimmed = value.trim();
      const error = validateFileName(trimmed);
      if (error || trimmed === initialName) {
        onCancel();
        return;
      }
      onSubmit(trimmed);
    },
    [initialName, onSubmit, onCancel],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      // Stop all key events from bubbling so parent button/tree doesn't react
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        commit(e.currentTarget.value);
      } else if (e.key === "Escape") {
        e.preventDefault();
        committedRef.current = true;
        onCancel();
      }
    },
    [commit, onCancel],
  );

  const handleBlur = useCallback(
    (e: React.FocusEvent<HTMLInputElement>) => {
      // If the input loses focus before we're ready (context menu focus-restore
      // race), re-focus instead of committing.
      if (!readyRef.current) {
        e.currentTarget.focus();
        return;
      }
      commit(e.currentTarget.value);
    },
    [commit],
  );

  return (
    <input
      ref={inputRef}
      autoFocus
      defaultValue={initialName}
      className="flex-1 min-w-0 bg-background text-foreground text-sm outline-none border border-ring rounded px-1"
      onKeyDown={handleKeyDown}
      onBlur={handleBlur}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    />
  );
});

function FileTreeItem({
  node,
  depth,
  selectedFilePath,
  onFileSelect,
  onFileHover,
  onDelete,
  onRename,
  renamingPath,
  onRenamingPathChange,
  openTabs,
}: FileTreeItemProps) {
  const [isExpanded, setIsExpanded] = useState(true);

  const isRenaming = renamingPath === node.path;
  const name = getFileName(node.path);

  // Determine if this item (or its children for directories) has open tabs
  const isOpen = useMemo(() => {
    if (!openTabs || openTabs.length === 0) return false;
    if (node.type === "file") {
      return openTabs.includes(node.path);
    }
    // For directories, check if any open tab is underneath
    const prefix = node.path.endsWith("/") ? node.path : node.path + "/";
    return openTabs.some((tab) => tab.startsWith(prefix));
  }, [openTabs, node.path, node.type]);

  const handleClick = () => {
    if (isRenaming) return;
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

  const handleRenameSubmit = useCallback(
    (newName: string) => {
      onRename?.(node.path, newName);
      onRenamingPathChange(null);
    },
    [node.path, onRename, onRenamingPathChange],
  );

  const handleRenameCancel = useCallback(() => {
    onRenamingPathChange(null);
  }, [onRenamingPathChange]);

  const paddingValue = depth * 12 + 8;

  const buttonElement = (
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
            {/* {isExpanded ? ( */}
            {/*   <FolderOpen className="w-4 h-4 shrink-0 text-muted-foreground" /> */}
            {/* ) : ( */}
            {/*   <Folder className="w-4 h-4 shrink-0 text-muted-foreground" /> */}
            {/* )} */}
          </>
        ) : (
          <>
            <span className="w-4 shrink-0" />
            {/* <FileText className="w-4 h-4 shrink-0 text-muted-foreground" /> */}
          </>
        )}
        {isRenaming ? (
          <RenameInput
            initialName={name}
            fileType={node.type}
            filePath={node.path}
            onSubmit={handleRenameSubmit}
            onCancel={handleRenameCancel}
          />
        ) : (
          <span className="truncate text-foreground">{name}</span>
        )}
      </div>
      <span className="shrink-0 text-xs text-muted-foreground uppercase tracking-wider"></span>
    </button>
  );

  return (
    <div>
      {onDelete ? (
        <FileTreeContextMenu
          path={node.path}
          type={node.type}
          onDelete={onDelete}
          onRenameStart={() => onRenamingPathChange(node.path)}
          disableRename={isOpen}
        >
          {buttonElement}
        </FileTreeContextMenu>
      ) : (
        buttonElement
      )}
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
              onDelete={onDelete}
              onRename={onRename}
              renamingPath={renamingPath}
              onRenamingPathChange={onRenamingPathChange}
              openTabs={openTabs}
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
  onDelete,
  onRename,
  openTabs,
  basePath,
  sortOrder = "name-asc",
}: FileTreeProps) {
  const { metadata } = getOrCreateWorkspaceCollections(basePath);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);

  const handleFileHover = useCallback(
    (filePath: string) => {
      prefetchFileContent(basePath, filePath).catch((error: unknown) => {
        console.debug(`Failed to prefetch ${filePath}:`, error);
      });
    },
    [basePath],
  );

  const { data: fileMetadataList = [] } = useLiveQuery(
    (q) =>
      q.from({ file: metadata }).select(({ file }) => ({
        path: file.path,
        relativePath: file.relativePath,
        type: file.type,
        modified: file.modified,
        size: file.size,
        contentHash: file.contentHash,
        error: file.error,
      })),
    [basePath],
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
    return flatEntriesToTree(files, basePath, sortOrder);
  }, [files, basePath, sortOrder]);

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
            onDelete={onDelete}
            onRename={onRename}
            renamingPath={renamingPath}
            onRenamingPathChange={setRenamingPath}
            openTabs={openTabs}
          />
        ))}
      </div>
    </ScrollArea>
  );
}
