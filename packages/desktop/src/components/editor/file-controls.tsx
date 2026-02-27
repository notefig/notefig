"use client";

import { FilePlus, FolderPlus, ArrowUpDown, PanelLeftClose, PanelLeft } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
} from "@/components/ui/tooltip";
import { useTranslation } from "react-i18next";

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
  const { t } = useTranslation();
  
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
                  <span className="sr-only">{t("newFile")}</span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t("newFile")}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={onNewFolder}
                  className="p-1.5 rounded hover:bg-sidebar-accent transition-colors"
                >
                  <FolderPlus className="w-4 h-4 text-muted-foreground" />
                  <span className="sr-only">{t("newFolder")}</span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t("newFolder")}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button className="p-1.5 rounded hover:bg-sidebar-accent transition-colors">
                  <ArrowUpDown className="w-4 h-4 text-muted-foreground" />
                  <span className="sr-only">{t("sort")}</span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t("sortFiles")}</TooltipContent>
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
                {isCollapsed ? t("expandSidebar") : t("collapseSidebar")}
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {isCollapsed ? t("expandSidebar") : t("collapseSidebar")}
          </TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  );
}
