import { useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { LayoutGrid, Plus, Settings } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@notefig/ui/tooltip";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@notefig/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@notefig/ui/dropdown-menu";
import { cn } from "@notefig/ui/utils";
import { useCloseWorkspace } from "@/components/editor/close-workspace-dialog";
import { useAgentRunsOverview } from "@/entities/agents";
import { useOpenWorkspaces } from "@/entities/workspaces";
import {
  useOpenProject,
  useOpenProjectFromPicker,
} from "@/hooks/use-open-project";
import {
  deriveProjectName,
  useRecentProjects,
} from "@/hooks/use-recent-projects";
import { workspaceKey } from "@/utils/path";

const MAX_RECENT_IN_MENU = 5;

interface GlobalColumnProps {
  /** The focused workspace — its chip is the current one. */
  workspacePath: string;
  isEverything: boolean;
  onShowEverything: () => void;
  onShowWorkspaceTools: (path: string) => void;
  onOpenSettings: () => void;
}

/**
 * The sidebar's global column — always there, whatever the workspace
 * column shows: the Everything view on top, one chip per open workspace
 * (the current one marked, each carrying the count of runs waiting on the
 * user in it), a way to add one, and settings at the foot. A right-click
 * on a chip closes its workspace.
 */
export function GlobalColumn({
  workspacePath,
  isEverything,
  onShowEverything,
  onShowWorkspaceTools,
  onOpenSettings,
}: GlobalColumnProps) {
  const { t } = useTranslation();
  const rows = useOpenWorkspaces();
  const { byWorkspace } = useAgentRunsOverview();
  const { requestClose, dialog } = useCloseWorkspace();
  const focusedKey = workspaceKey(workspacePath);

  return (
    <div className="flex h-full w-11 shrink-0 flex-col items-center gap-1 border-e border-border bg-muted/40 py-2">
      <ColumnButton
        label={t("everything")}
        active={isEverything}
        onClick={onShowEverything}
      >
        <LayoutGrid className="size-4" />
      </ColumnButton>
      <div className="my-1 h-px w-5 bg-border" />

      {rows.map((row) => {
        const name = deriveProjectName(row.path);
        const attention = byWorkspace.get(row.key)?.attention ?? 0;
        const current = !isEverything && row.key === focusedKey;
        return (
          <ContextMenu key={row.key}>
            <ContextMenuTrigger asChild>
              <div>
                <ColumnButton
                  label={
                    attention
                      ? t("workspaceChipAttention", { name, count: attention })
                      : name
                  }
                  active={current}
                  current={current}
                  onClick={() => onShowWorkspaceTools(row.path)}
                >
                  <span className="text-xs font-semibold">
                    {initial(name)}
                  </span>
                  {attention > 0 && (
                    <span
                      aria-hidden="true"
                      className="absolute -end-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-destructive px-0.5 text-[0.5625rem] font-bold leading-none text-destructive-foreground animate-in zoom-in-50 duration-200 motion-reduce:animate-none"
                    >
                      {attention}
                    </span>
                  )}
                </ColumnButton>
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onSelect={() => requestClose(row.path)}>
                {t("closeWorkspaceAction")}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        );
      })}

      <AddWorkspaceButton />

      <div className="mt-auto">
        <ColumnButton label={t("settings")} onClick={onOpenSettings}>
          <Settings className="size-4" />
        </ColumnButton>
      </div>
      {dialog}
    </div>
  );
}

/** The chip's letter: the first character of the workspace's name. */
function initial(name: string): string {
  const first = [...name.trim()][0];
  return first ? first.toUpperCase() : "?";
}

function ColumnButton({
  label,
  active,
  current,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  current?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={label}
          aria-pressed={active}
          aria-current={current ? "true" : undefined}
          className={cn(
            "relative flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
            active && "bg-accent text-foreground shadow-sm ring-1 ring-border",
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" className="rtl:hidden" sideOffset={8}>
        {label}
      </TooltipContent>
      <TooltipContent side="left" className="ltr:hidden" sideOffset={8}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

/** "+": recent projects not yet open, then the folder picker. */
function AddWorkspaceButton() {
  const { t } = useTranslation();
  const openProject = useOpenProject();
  const openFolder = useOpenProjectFromPicker();
  const { recentProjects } = useRecentProjects();
  const openRows = useOpenWorkspaces();

  const otherProjects = useMemo(() => {
    const openKeys = new Set(openRows.map((row) => row.key));
    return recentProjects
      .filter((project) => !openKeys.has(workspaceKey(project.path)))
      .slice(0, MAX_RECENT_IN_MENU);
  }, [recentProjects, openRows]);

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t("addWorkspace")}
              className="flex size-8 items-center justify-center rounded-md border border-dashed border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Plus className="size-4" />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={8}>
          {t("addWorkspace")}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent side="right" align="start" className="w-52">
        {otherProjects.length > 0 && (
          <>
            <DropdownMenuLabel className="py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
              {t("recentWorkspaces")}
            </DropdownMenuLabel>
            {otherProjects.map((project) => (
              <DropdownMenuItem
                key={project.path}
                className="py-1 text-xs"
                onSelect={() => void openProject(project.path)}
              >
                <span className="truncate">{project.name}</span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem
          className="py-1 text-xs"
          onSelect={() => void openFolder()}
        >
          {t("openFolder")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
