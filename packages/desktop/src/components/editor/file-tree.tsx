import { useMemo, useState, useCallback, useRef, useEffect, memo } from "react";
import { useHotkey, useKeyHold } from "@tanstack/react-hotkeys";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useTranslation } from "react-i18next";
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
import type { OpenFileInLayoutOptions } from "@/utils/dockable-layout";
import { requestElementFocus } from "@/utils/focus-arbiter";

/** Discriminated union representing the file tree's inline-editing state. */
export type FileTreeMode =
  | { type: "idle" }
  | { type: "renaming"; path: string }
  | { type: "creating"; parentPath: string; itemType: "file" | "directory" };

export const FILE_TREE_IDLE: FileTreeMode = { type: "idle" };

interface FileTreeProps {
  selectedFilePath: string | null;
  onFileSelect: (
    file: FileTreeNode,
    options?: Omit<OpenFileInLayoutOptions, "tabId">,
  ) => void;
  onDelete?: (path: string) => void;
  onRename?: (oldPath: string, newName: string) => void;
  onCreate?: (
    parentPath: string,
    name: string,
    type: "file" | "directory",
  ) => void;
  openTabs?: string[];
  basePath: string;
  sortOrder?: SortOrder;
  mode: FileTreeMode;
  onModeChange: (mode: FileTreeMode) => void;
}

interface FileTreeItemProps {
  node: FileTreeNode;
  depth: number;
  isPrimaryFocusTarget?: boolean;
  selectedFilePath: string | null;
  onFileSelect: (
    file: FileTreeNode,
    options?: Omit<OpenFileInLayoutOptions, "tabId">,
  ) => void;
  onFileHover?: (filePath: string) => void;
  onDelete?: (path: string) => void;
  onRequestDelete: (path: string, type: "file" | "directory") => void;
  onRename?: (oldPath: string, newName: string) => void;
  onCreate?: (
    parentPath: string,
    name: string,
    type: "file" | "directory",
  ) => void;
  openTabs?: string[];
  mode: FileTreeMode;
  onModeChange: (mode: FileTreeMode) => void;
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
  const focusKey = `file-tree-rename-${filePath}`;
  const committedRef = useRef(false);

  useEffect(() => {
    requestElementFocus(focusKey, {
      domain: "sidebar",
      priority: 85,
      reason: "file-tree-rename",
      when: "when-mounted",
    });
  }, [focusKey]);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    if (document.activeElement !== input) return;

    if (fileType === "file") {
      const ext = getFileExtension(filePath);
      const nameWithoutExt = ext
        ? initialName.slice(0, -(ext.length + 1))
        : initialName;
      input.setSelectionRange(0, nameWithoutExt.length);
    } else {
      input.select();
    }
  }, [filePath, fileType, initialName]);

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
      commit(e.currentTarget.value);
    },
    [commit],
  );

  return (
    <input
      ref={inputRef}
      data-focus-key={focusKey}
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

/**
 * Input component for creating new files/directories.
 * Starts with an empty value. On commit, validates the name and calls onSubmit.
 * On Escape or empty blur, cancels.
 */
interface NewFileInputProps {
  type: "file" | "directory";
  onSubmit: (name: string) => void;
  onCancel: () => void;
  depth: number;
}

const NewFileInput = memo(function NewFileInput({
  type,
  onSubmit,
  onCancel,
  depth,
}: NewFileInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const committedRef = useRef(false);
  const focusKey = `file-tree-create-${depth}-${type}`;

  useEffect(() => {
    requestElementFocus(focusKey, {
      domain: "sidebar",
      priority: 85,
      reason: "file-tree-create",
      when: "when-mounted",
    });
  }, [focusKey]);

  const commit = useCallback(
    (value: string) => {
      if (committedRef.current) return;
      committedRef.current = true;

      const trimmed = value.trim();
      const error = validateFileName(trimmed);
      if (error || trimmed.length === 0) {
        onCancel();
        return;
      }
      onSubmit(trimmed);
    },
    [onSubmit, onCancel],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
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
      commit(e.currentTarget.value);
    },
    [commit],
  );

  const paddingValue = depth * 12 + 8;

  return (
    <div
      className="flex items-center gap-1 px-2 py-1"
      style={{
        paddingInlineStart: `${paddingValue}px`,
        paddingInlineEnd: "8px",
      }}
    >
      <div className="flex items-center gap-1 flex-1 min-w-0">
        {type === "directory" ? (
          <ChevronRight className="w-4 h-4 shrink-0 text-muted-foreground rtl:-scale-x-100" />
        ) : (
          <span className="w-4 shrink-0" />
        )}
        <input
          ref={inputRef}
          data-focus-key={focusKey}
          autoFocus
          placeholder={type === "file" ? "filename.md" : "folder name"}
          className="flex-1 min-w-0 bg-background text-foreground text-sm outline-none border border-ring rounded px-1"
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        />
      </div>
    </div>
  );
});

function FileTreeItem({
  node,
  depth,
  isPrimaryFocusTarget = false,
  selectedFilePath,
  onFileSelect,
  onFileHover,
  onDelete,
  onRequestDelete,
  onRename,
  onCreate,
  openTabs,
  mode,
  onModeChange,
}: FileTreeItemProps) {
  const [isExpanded, setIsExpanded] = useState(depth === 0);
  const isMetaHeld = useKeyHold("Meta");
  const isControlHeld = useKeyHold("Control");
  const isModHeld = isMetaHeld || isControlHeld;

  const isRenaming = mode.type === "renaming" && mode.path === node.path;
  const isCreatingHere =
    node.type === "directory" &&
    mode.type === "creating" &&
    mode.parentPath === node.path;
  const creatingItemType = mode.type === "creating" ? mode.itemType : null;
  const name = getFileName(node.path);

  useEffect(() => {
    if (isCreatingHere && !isExpanded) {
      setIsExpanded(true);
    }
  }, [isCreatingHere]);

  const isOpen = useMemo(() => {
    if (!openTabs || openTabs.length === 0) return false;
    if (node.type === "file") {
      return openTabs.includes(node.path);
    }
    const prefix = node.path.endsWith("/") ? node.path : node.path + "/";
    return openTabs.some((tab) => tab.startsWith(prefix));
  }, [openTabs, node.path, node.type]);

  const handleClick = () => {
    if (isRenaming) return;
    if (node.type === "directory") {
      setIsExpanded(!isExpanded);
    } else {
      onFileSelect(
        node,
        isModHeld ? { intent: "new-tab" } : { intent: "replace" },
      );
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
      onModeChange(FILE_TREE_IDLE);
    },
    [node.path, onRename, onModeChange],
  );

  const handleRenameCancel = useCallback(() => {
    onModeChange(FILE_TREE_IDLE);
  }, [onModeChange]);

  const handleCreateSubmit = useCallback(
    (name: string) => {
      if (mode.type === "creating") {
        onCreate?.(mode.parentPath, name, mode.itemType);
      }
      onModeChange(FILE_TREE_IDLE);
    },
    [mode, onCreate, onModeChange],
  );

  const handleCreateCancel = useCallback(() => {
    onModeChange(FILE_TREE_IDLE);
  }, [onModeChange]);

  const handleNewFileInDir = useCallback(
    (dirPath: string) => {
      onModeChange({ type: "creating", parentPath: dirPath, itemType: "file" });
    },
    [onModeChange],
  );

  const handleNewFolderInDir = useCallback(
    (dirPath: string) => {
      onModeChange({
        type: "creating",
        parentPath: dirPath,
        itemType: "directory",
      });
    },
    [onModeChange],
  );

  const handleOpenInNewTab = useCallback(
    (path: string) => {
      onFileSelect(
        {
          path,
          type: "file",
          contentHash: "",
          content: "",
        },
        { intent: "new-tab" },
      );
    },
    [onFileSelect],
  );

  const paddingValue = depth * 12 + 8;

  const buttonElement = (
    <button
      data-focus-key={
        isPrimaryFocusTarget ? "sidebar-first-file-item" : undefined
      }
      data-file-path={node.path}
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
          onRequestDelete={() => onRequestDelete(node.path, node.type)}
          onRenameStart={() =>
            onModeChange({ type: "renaming", path: node.path })
          }
          onOpenInNewTab={node.type === "file" ? handleOpenInNewTab : undefined}
          onNewFile={handleNewFileInDir}
          onNewFolder={handleNewFolderInDir}
          disableRename={isOpen}
        >
          {buttonElement}
        </FileTreeContextMenu>
      ) : (
        buttonElement
      )}
      {node.type === "directory" && isExpanded && (
        <div>
          {isCreatingHere && creatingItemType && (
            <NewFileInput
              type={creatingItemType}
              onSubmit={handleCreateSubmit}
              onCancel={handleCreateCancel}
              depth={depth + 1}
            />
          )}
          {node.children?.map((child) => (
            <FileTreeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              isPrimaryFocusTarget={false}
              selectedFilePath={selectedFilePath}
              onFileSelect={onFileSelect}
              onFileHover={onFileHover}
              onDelete={onDelete}
              onRequestDelete={onRequestDelete}
              onRename={onRename}
              onCreate={onCreate}
              openTabs={openTabs}
              mode={mode}
              onModeChange={onModeChange}
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
  onCreate,
  openTabs,
  basePath,
  sortOrder = "name-asc",
  mode,
  onModeChange,
}: FileTreeProps) {
  const { t } = useTranslation();
  const { metadata } = getOrCreateWorkspaceCollections(basePath);
  const [pendingDelete, setPendingDelete] = useState<{
    path: string;
    type: "file" | "directory";
  } | null>(null);

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

  const isCreatingAtRoot =
    mode.type === "creating" && mode.parentPath === basePath;
  const rootCreatingItemType = mode.type === "creating" ? mode.itemType : null;
  const treeRootRef = useRef<HTMLDivElement>(null);

  const handleCreateSubmitRoot = useCallback(
    (name: string) => {
      if (mode.type === "creating") {
        onCreate?.(mode.parentPath, name, mode.itemType);
      }
      onModeChange(FILE_TREE_IDLE);
    },
    [mode, onCreate, onModeChange],
  );

  const handleCreateCancelRoot = useCallback(() => {
    onModeChange(FILE_TREE_IDLE);
  }, [onModeChange]);

  const handleHotkeyDelete = useCallback(() => {
    if (!onDelete) return;
    if (mode.type !== "idle") return;

    const active = document.activeElement;
    if (
      active instanceof HTMLButtonElement &&
      active.dataset.filePath &&
      active.closest("[data-file-tree-root]")
    ) {
      const filePath = active.dataset.filePath;
      const entry = files[filePath];
      const type = entry?.type === "directory" ? "directory" : "file";
      setPendingDelete({ path: filePath, type });
    }
  }, [mode.type, onDelete, files]);

  const handleRequestDelete = useCallback(
    (path: string, type: "file" | "directory") => {
      setPendingDelete({ path, type });
    },
    [],
  );

  useHotkey("Mod+Backspace", handleHotkeyDelete, {
    enabled: Boolean(onDelete),
    target: treeRootRef,
  });

  return (
    <ScrollArea className="h-full w-full">
      <div className="py-1" data-file-tree-root ref={treeRootRef}>
        {isCreatingAtRoot && rootCreatingItemType && (
          <NewFileInput
            type={rootCreatingItemType}
            onSubmit={handleCreateSubmitRoot}
            onCancel={handleCreateCancelRoot}
            depth={0}
          />
        )}
        {filesTree.map((node) => (
          <FileTreeItem
            key={node.path}
            node={node}
            depth={0}
            isPrimaryFocusTarget={filesTree[0]?.path === node.path}
            selectedFilePath={selectedFilePath}
            onFileSelect={onFileSelect}
            onFileHover={handleFileHover}
            onDelete={onDelete}
            onRequestDelete={handleRequestDelete}
            onRename={onRename}
            onCreate={onCreate}
            openTabs={openTabs}
            mode={mode}
            onModeChange={onModeChange}
          />
        ))}
      </div>

      {pendingDelete && (
        <AlertDialog
          open
          onOpenChange={(open) => {
            if (!open) setPendingDelete(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t("deleteConfirmTitle", 'Delete "{{name}}"?', {
                  name: getFileName(pendingDelete.path),
                })}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {pendingDelete.type === "directory"
                  ? t(
                      "deleteDirectoryConfirm",
                      "This will permanently delete the folder and all its contents. This action cannot be undone.",
                    )
                  : t(
                      "deleteFileConfirm",
                      "This will permanently delete the file. This action cannot be undone.",
                    )}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={() => setPendingDelete(null)}>
                {t("cancel", "Cancel")}
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  if (pendingDelete && onDelete) {
                    onDelete(pendingDelete.path);
                  }
                  setPendingDelete(null);
                }}
              >
                {t("delete", "Delete")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </ScrollArea>
  );
}
