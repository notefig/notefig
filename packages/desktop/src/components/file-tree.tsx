import * as React from "react";
import { Icons } from "@/components/icons";
import { cn } from "@/lib/utils";

type FileNode = {
  id: string;
  name: string;
  type: "file" | "folder";
  children?: FileNode[];
};

const FILES: FileNode[] = [
  {
    id: "1",
    name: "documentation",
    type: "folder",
    children: [
      { id: "2", name: "introduction.md", type: "file" },
      { id: "3", name: "getting-started.md", type: "file" },
      { id: "4", name: "architecture.md", type: "file" },
    ],
  },
  {
    id: "5",
    name: "blog",
    type: "folder",
    children: [
      { id: "6", name: "2024-plans.md", type: "file" },
      { id: "7", name: "new-features.md", type: "file" },
    ],
  },
  { id: "8", name: "README.md", type: "file" },
  { id: "9", name: "CONTRIBUTING.md", type: "file" },
  { id: "10", name: "LICENSE", type: "file" },
];

interface FileTreeProps {
  className?: string;
  selectedId?: string;
  onSelect?: (id: string) => void;
}

export function FileTree({ className, selectedId, onSelect }: FileTreeProps) {
  return (
    <div className={cn("flex flex-col gap-1 text-sm", className)}>
      {FILES.map((node) => (
        <FileTreeNode
          key={node.id}
          node={node}
          level={0}
          selectedId={selectedId}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

interface FileTreeNodeProps {
  node: FileNode;
  level: number;
  selectedId?: string;
  onSelect?: (id: string) => void;
}

function FileTreeNode({
  node,
  level,
  selectedId,
  onSelect,
}: FileTreeNodeProps) {
  const [isOpen, setIsOpen] = React.useState(level === 0);
  const isSelected = node.id === selectedId;
  const isFolder = node.type === "folder";

  const Icon = isFolder
    ? isOpen
      ? Icons.folderOpen
      : Icons.folder
    : getFileIcon(node.name);

  return (
    <>
      <button
        onClick={() => {
          if (isFolder) {
            setIsOpen(!isOpen);
          } else {
            onSelect?.(node.id);
          }
        }}
        className={cn(
          "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
          isSelected &&
            "bg-sidebar-accent text-sidebar-accent-foreground font-medium",
          isFolder && "font-medium text-foreground",
        )}
        style={{ paddingLeft: `${level * 12 + 8}px` }}
      >
        <Icon className="h-4 w-4 shrink-0" />
        <span className="truncate">{node.name}</span>
        {isFolder && (
          <Icons.chevronRight
            className={cn(
              "ml-auto h-3.5 w-3.5 shrink-0 transition-transform",
              isOpen && "rotate-90",
            )}
          />
        )}
      </button>
      {isFolder && isOpen && node.children && (
        <div className="flex flex-col gap-1">
          {node.children.map((child) => (
            <FileTreeNode
              key={child.id}
              node={child}
              level={level + 1}
              selectedId={selectedId}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </>
  );
}

function getFileIcon(filename: string) {
  if (filename.endsWith(".md")) return Icons.fileText;
  if (filename.endsWith(".ts") || filename.endsWith(".tsx"))
    return Icons.fileCode;
  return Icons.file;
}
