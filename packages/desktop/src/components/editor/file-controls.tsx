"use client";

import {
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
  TooltipProvider,
} from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import type { SortOrder } from "@/utils/fs";

interface FileControlsProps {
  onNewFile: () => void;
  onNewFolder: () => void;
  sortOrder: SortOrder;
  onSortChange: (order: SortOrder) => void;
}

const sortIcons: Record<SortOrder, typeof ArrowDownAZ> = {
  "name-asc": ArrowDownAZ,
  "name-desc": ArrowUpZA,
  "date-modified": CalendarArrowDown,
};

export function FileControls({
  onNewFile,
  onNewFolder,
  sortOrder,
  onSortChange,
}: FileControlsProps) {
  const { t } = useTranslation();

  const SortIcon = sortIcons[sortOrder];

  return (
    <TooltipProvider>
      <div className="flex items-center justify-between h-9 px-2 bg-sidebar border-b border-sidebar-border">
        <ButtonGroup>
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
            <TooltipContent side="bottom">{t("newFile")}</TooltipContent>
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
            <TooltipContent side="bottom">{t("newFolder")}</TooltipContent>
          </Tooltip>
        </ButtonGroup>
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground"
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
    </TooltipProvider>
  );
}
