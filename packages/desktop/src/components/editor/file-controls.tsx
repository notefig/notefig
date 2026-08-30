"use client";

import { ArrowDownAZ, ArrowUpZA, CalendarArrowDown } from "lucide-react";
// The three creation actions use Pierre's set, matching the file tree they
// sit on (@pierre/trees renders the rows and their file-type glyphs) and the
// tree's own context menu. Sized to 3.5 to match that menu — passed as a
// className so tailwind-merge drops the Button's own `[&_svg]:size-4` rather
// than the two fighting on specificity. The icons default to `currentcolor`,
// so they inherit the button's text color like the lucide ones did.
import { IconFilePlus, IconFolderPlus, IconHash } from "@pierre/icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "@notefig/ui/tooltip";
import { Button } from "@notefig/ui/button";
import { ButtonGroup } from "@notefig/ui/button-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@notefig/ui/dropdown-menu";
import { WorkspaceSwitcher } from "@/components/editor/workspace-switcher";
import { cn } from "@notefig/ui/utils";
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

  // No z-index on the pill: later-in-DOM keeps it over plain tree rows,
  // while the tree's context menu (z-index 3-4 inside its host) paints —
  // and clicks — above it instead of having menu items intercepted.
  return (
    // bg-popover/border-border, not bg-sidebar/border-sidebar-border: there
    // are no --sidebar tokens in this theme, so those two utilities compiled
    // to nothing and the pill floated over the tree with no background at
    // all — just a default-coloured border and a shadow. These are the same
    // tokens the tree's own context menu uses, which is the app's existing
    // "floating surface" treatment.
    <ButtonGroup className="absolute bottom-2 end-2 rounded-md border border-border bg-popover shadow-md">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground [&_svg]:size-3.5"
            onClick={onNewScratchpad}
          >
            <IconHash />
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
            className="h-7 w-7 text-muted-foreground [&_svg]:size-3.5"
            onClick={onNewFile}
          >
            <IconFilePlus />
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
            className="h-7 w-7 text-muted-foreground [&_svg]:size-3.5"
            onClick={onNewFolder}
          >
            <IconFolderPlus />
            <span className="sr-only">{t("newFolder")}</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">{t("newFolder")}</TooltipContent>
      </Tooltip>
    </ButtonGroup>
  );
}
