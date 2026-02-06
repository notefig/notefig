import { useMemo, useState } from "react";
import {
  FileText,
  Folder,
  FolderOpen,
  ChevronRight,
  ChevronDown,
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { FileTreeNode, flatEntriesToTree, getFileName } from "@/utils/fs";
import { getOrCreateStore } from "@/utils/tinybase";
import { useTable } from "tinybase/ui-react";

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
}

function FileTreeItem({
  node,
  depth,
  selectedFilePath,
  onFileSelect,
}: FileTreeItemProps) {
  const [isExpanded, setIsExpanded] = useState(true);

  const handleClick = () => {
    if (node.type === "directory") {
      setIsExpanded(!isExpanded);
    } else {
      onFileSelect(node);
    }
  };

  const paddingValue = depth * 12 + 8;
  const name = getFileName(node.path);

  return (
    <div>
      <button
        onClick={handleClick}
        onMouseDown={handleClick}
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
  const store = getOrCreateStore(basePath);
  const files = useTable("files", store);
  const filesTree = useMemo(() => {
    return flatEntriesToTree(files as any);
  }, [files]);
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
          />
        ))}
      </div>
    </ScrollArea>
  );
}
