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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@notefig/ui/dropdown-menu";
import { cn } from "@notefig/ui/utils";
import { ToolBar } from "@/components/editor/tool-bar";
import { useTranslation } from "react-i18next";
import type { SortOrder } from "@/utils/fs";

interface FileControlsProps {
  workspacePath: string;
  sortOrder: SortOrder;
  onSortChange: (order: SortOrder) => void;
  onNewScratchpad: () => void;
  onNewFile: () => void;
  onNewFolder: () => void;
}

const sortIcons: Record<SortOrder, typeof ArrowDownAZ> = {
  "name-asc": ArrowDownAZ,
  "name-desc": ArrowUpZA,
  "date-modified": CalendarArrowDown,
};

/** The file tree's control row: the three creation actions at the
 *  start, the sort menu at the end. */
export function FileControls({
  workspacePath,
  sortOrder,
  onSortChange,
  onNewScratchpad,
  onNewFile,
  onNewFolder,
}: FileControlsProps) {
  const { t } = useTranslation();

  const SortIcon = sortIcons[sortOrder];

  return (
    <ToolBar className="justify-between">
      <FileCreateActions
        onNewScratchpad={onNewScratchpad}
        onNewFile={onNewFile}
        onNewFolder={onNewFolder}
      />
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
    </ToolBar>
  );
}

interface FileCreateActionsProps {
  onNewScratchpad: () => void;
  onNewFile: () => void;
  onNewFolder: () => void;
}

/** The three creation actions, as plain icon buttons in the control row. */
function FileCreateActions({
  onNewScratchpad,
  onNewFile,
  onNewFolder,
}: FileCreateActionsProps) {
  const { t } = useTranslation();
  const actions = [
    { label: t("newScratchpad"), Icon: IconHash, onClick: onNewScratchpad },
    { label: t("newFile"), Icon: IconFilePlus, onClick: onNewFile },
    { label: t("newFolder"), Icon: IconFolderPlus, onClick: onNewFolder },
  ];
  return (
    <div className="flex items-center gap-0.5">
      {actions.map(({ label, Icon, onClick }) => (
        <Tooltip key={label}>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground [&_svg]:size-3.5"
              onClick={onClick}
            >
              <Icon />
              <span className="sr-only">{label}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{label}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}
