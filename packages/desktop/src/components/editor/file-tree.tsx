"use client";

import { useState } from "react";
import {
  FileText,
  Folder,
  FolderOpen,
  ChevronRight,
  ChevronDown,
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

export interface FileNode {
  id: string;
  name: string;
  type: "file" | "folder";
  children?: FileNode[];
  label?: string;
}

interface FileTreeProps {
  files: FileNode[];
  selectedFileId: string | null;
  onFileSelect: (file: FileNode) => void;
}

interface FileTreeItemProps {
  node: FileNode;
  depth: number;
  selectedFileId: string | null;
  onFileSelect: (file: FileNode) => void;
}

function FileTreeItem({
  node,
  depth,
  selectedFileId,
  onFileSelect,
}: FileTreeItemProps) {
  const [isExpanded, setIsExpanded] = useState(true);

  const handleClick = () => {
    if (node.type === "folder") {
      setIsExpanded(!isExpanded);
    } else {
      onFileSelect(node);
    }
  };

  const paddingValue = depth * 12 + 8;

  return (
    <div>
      <button
        onClick={handleClick}
        className={cn(
          "w-full flex items-center gap-1 px-2 py-1 text-sm hover:bg-accent/50 transition-colors",
          selectedFileId === node.id && node.type === "file" && "bg-accent",
        )}
        style={{
          paddingInlineStart: `${paddingValue}px`,
          paddingInlineEnd: "8px",
        }}
      >
        {/* Icons and name container - reverses in RTL */}
        <div className="flex items-center gap-1 flex-1 min-w-0">
          {node.type === "folder" ? (
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
          <span className="truncate text-foreground">{node.name}</span>
        </div>
        {/* Label stays at the opposite end */}
        {node.label && (
          <span className="shrink-0 text-xs text-muted-foreground uppercase tracking-wider">
            {node.label}
          </span>
        )}
      </button>
      {node.type === "folder" && isExpanded && node.children && (
        <div>
          {node.children.map((child) => (
            <FileTreeItem
              key={child.id}
              node={child}
              depth={depth + 1}
              selectedFileId={selectedFileId}
              onFileSelect={onFileSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function FileTree({
  files,
  selectedFileId,
  onFileSelect,
}: FileTreeProps) {
  return (
    <ScrollArea className="flex-1">
      <div className="py-1">
        {files.map((node) => (
          <FileTreeItem
            key={node.id}
            node={node}
            depth={0}
            selectedFileId={selectedFileId}
            onFileSelect={onFileSelect}
          />
        ))}
      </div>
    </ScrollArea>
  );
}
