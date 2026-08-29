"use client";

import {
  Hash,
  FilePlus,
  FolderPlus,
  ArrowDownAZ,
  ArrowUpZA,
  CalendarArrowDown,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { WorkspaceSwitcher } from "@/components/editor/workspace-switcher";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import type { SortOrder } from "@/utils/fs";

interface FileControlsProps {
  workspacePath: string;
  sortOrder: SortOrder;
  onSortChange: (order: SortOrder) => void;
}

const sortIcons: Record<SortOrder, typeof ArrowDownAZ> = {
  "name-asc": ArrowDownAZ,
  "name-desc": ArrowUpZA,
  "date-modified": CalendarArrowDown,
};

export function FileControls({
  workspacePath,
  sortOrder,
  onSortChange,
}: FileControlsProps) {
  const { t } = useTranslation();

  const SortIcon = sortIcons[sortOrder];

  return (
    <div className="flex h-9 items-center justify-between gap-1 border-b border-sidebar-border bg-sidebar px-2">
      <WorkspaceSwitcher workspacePath={workspacePath} />
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0 text-muted-foreground"
                aria-label={t("sortFiles")}
              >
                <SortIcon className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t("sortFiles")}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            className={cn(
              "flex items-center justify-between gap-3",
              sortOrder === "name-asc" && "bg-accent",
            )}
            onSelect={() => onSortChange("name-asc")}
          >
            {t("sortNameAsc")}
            <ArrowDownAZ className="h-4 w-4 text-muted-foreground" />
          </DropdownMenuItem>
          <DropdownMenuItem
            className={cn(
              "flex items-center justify-between gap-3",
              sortOrder === "name-desc" && "bg-accent",
            )}
            onSelect={() => onSortChange("name-desc")}
          >
            {t("sortNameDesc")}
            <ArrowUpZA className="h-4 w-4 text-muted-foreground" />
          </DropdownMenuItem>
          <DropdownMenuItem
            className={cn(
              "flex items-center justify-between gap-3",
              sortOrder === "date-modified" && "bg-accent",
            )}
            onSelect={() => onSortChange("date-modified")}
          >
            {t("sortDateModified")}
            <CalendarArrowDown className="h-4 w-4 text-muted-foreground" />
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

interface FileCreateActionsProps {
  onNewScratchpad: () => void;
  onNewFile: () => void;
  onNewFolder: () => void;
}

/**
 * The three creation actions, floating over the bottom end of the file
 * tree (the tree wrapper provides the positioning context).
 */
export function FileCreateActions({
  onNewScratchpad,
  onNewFile,
  onNewFolder,
}: FileCreateActionsProps) {
  const { t } = useTranslation();

  return (
    <ButtonGroup className="absolute bottom-2 end-2 z-10 rounded-md border border-sidebar-border bg-sidebar shadow-md">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground"
            onClick={onNewScratchpad}
          >
            <Hash className="h-4 w-4" />
            <span className="sr-only">{t("newScratchpad")}</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">{t("newScratchpad")}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground"
            onClick={onNewFile}
          >
            <FilePlus className="h-4 w-4" />
            <span className="sr-only">{t("newFile")}</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">{t("newFile")}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground"
            onClick={onNewFolder}
          >
            <FolderPlus className="h-4 w-4" />
            <span className="sr-only">{t("newFolder")}</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">{t("newFolder")}</TooltipContent>
      </Tooltip>
    </ButtonGroup>
  );
}
