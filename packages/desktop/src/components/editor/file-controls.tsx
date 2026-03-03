"use client";

import { FilePlus, FolderPlus } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
} from "@/components/ui/tooltip";
import { useTranslation } from "react-i18next";

interface FileControlsProps {
  onNewFile: () => void;
  onNewFolder: () => void;
}

export function FileControls({ onNewFile, onNewFolder }: FileControlsProps) {
  const { t } = useTranslation();

  return (
    <TooltipProvider>
      <div className="flex items-center justify-between h-9 px-2 bg-sidebar border-b border-sidebar-border">
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
        </div>
      </div>
    </TooltipProvider>
  );
}
