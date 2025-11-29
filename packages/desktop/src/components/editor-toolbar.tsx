import type React from "react";

import { Icons } from "@/components/icons";
import { cn } from "@/lib/utils";

interface EditorToolbarProps {
  className?: string;
  isModified?: boolean;
  isSaving?: boolean;
  fileName?: string;
  onSave?: () => void;
}

export function EditorToolbar({
  className,
  isModified = false,
  isSaving = false,
  fileName = "Untitled",
  onSave,
}: EditorToolbarProps) {
  return (
    <div
      className={cn(
        "sticky top-0 z-20 flex items-center justify-between border-b bg-background/95 px-4 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/60",
        className,
      )}
    >
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">
            {fileName}
          </span>
          {isModified && (
            <span className="text-xs px-2 py-1 bg-orange-100 text-orange-800 rounded-full">
              Modified
            </span>
          )}
        </div>

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
      </div>

      <div className="flex items-center gap-2">
        {isSaving && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <div className="animate-spin">
              <Icons.folder className="h-4 w-4" />
            </div>
            Saving...
          </div>
        )}
        <button
          onClick={onSave}
          disabled={!isModified || isSaving}
          className={cn(
            "flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md transition-colors",
            isModified && !isSaving
              ? "bg-primary text-primary-foreground hover:bg-primary/90"
              : "bg-muted text-muted-foreground cursor-not-allowed",
          )}
        >
          <Icons.save className="h-4 w-4" />
          Save
        </button>
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
