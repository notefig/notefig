"use client";

import { FilePlus, FolderPlus, ArrowUpDown, PanelLeftClose, PanelLeft } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
} from "@/components/ui/tooltip";

interface FileControlsProps {
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  onNewFile: () => void;
  onNewFolder: () => void;
}

export function FileControls({
  isCollapsed,
  onToggleCollapse,
  onNewFile,
  onNewFolder,
}: FileControlsProps) {
  return (
    <TooltipProvider>
      <div className="flex items-center justify-between h-9 px-2 bg-sidebar border-b border-sidebar-border">
        {/* Only show file controls when not collapsed */}
        {!isCollapsed && (
          <div className="flex items-center gap-0.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={onNewFile}
                  className="p-1.5 rounded hover:bg-sidebar-accent transition-colors"
                >
                  <FilePlus className="w-4 h-4 text-muted-foreground" />
                  <span className="sr-only">New file</span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">New file</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={onNewFolder}
                  className="p-1.5 rounded hover:bg-sidebar-accent transition-colors"
                >
                  <FolderPlus className="w-4 h-4 text-muted-foreground" />
                  <span className="sr-only">New folder</span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">New folder</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button className="p-1.5 rounded hover:bg-sidebar-accent transition-colors">
                  <ArrowUpDown className="w-4 h-4 text-muted-foreground" />
                  <span className="sr-only">Sort</span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Sort files</TooltipContent>
            </Tooltip>
          </div>
        )}
        
        {/* Spacer when collapsed to push toggle to the right */}
        {isCollapsed && <div />}
        
        {/* Toggle button - always visible */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onToggleCollapse}
              className="p-1.5 rounded hover:bg-sidebar-accent transition-colors"
            >
              {isCollapsed ? (
                <PanelLeft className="w-4 h-4 text-muted-foreground" />
              ) : (
                <PanelLeftClose className="w-4 h-4 text-muted-foreground" />
              )}
              <span className="sr-only">
                {isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          </TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  );
}
