import type React from "react";

import { Icons } from "@/components/icons";
import { cn } from "@/lib/utils";

interface EditorToolbarProps {
  className?: string;
}

export function EditorToolbar({ className }: EditorToolbarProps) {
  return (
    <div
      className={cn(
        "sticky top-0 z-20 flex items-center gap-1 border-b bg-background/95 px-4 py-1 backdrop-blur supports-[backdrop-filter]:bg-background/60",
        className,
      )}
    >
      <div className="flex items-center gap-1">
        <ToolbarButton icon={Icons.bold} label="Bold" />
        <ToolbarButton icon={Icons.italic} label="Italic" />
        <ToolbarButton icon={Icons.strikethrough} label="Strikethrough" />
      </div>

      <div className="mx-2 h-4 w-px bg-border" />

      <div className="flex items-center gap-1">
        <ToolbarButton icon={Icons.h1} label="Heading 1" />
        <ToolbarButton icon={Icons.h2} label="Heading 2" />
        <ToolbarButton icon={Icons.h3} label="Heading 3" />
      </div>

      <div className="mx-2 h-4 w-px bg-border" />

      <div className="flex items-center gap-1">
        <ToolbarButton icon={Icons.list} label="Bullet List" />
        <ToolbarButton icon={Icons.listOrdered} label="Ordered List" />
        <ToolbarButton icon={Icons.check} label="Check List" />
      </div>

      <div className="mx-2 h-4 w-px bg-border" />

      <div className="flex items-center gap-1">
        <ToolbarButton icon={Icons.link} label="Link" />
        <ToolbarButton icon={Icons.image} label="Image" />
        <ToolbarButton icon={Icons.quote} label="Blockquote" />
      </div>
    </div>
  );
}

function ToolbarButton({
  icon: Icon,
  label,
  onClick,
}: {
  icon: React.ElementType;
  label: string;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
      title={label}
      type="button"
    >
      <Icon className="h-4 w-4" />
      <span className="sr-only">{label}</span>
    </button>
  );
}
