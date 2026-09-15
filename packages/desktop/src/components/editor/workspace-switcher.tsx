"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { Button } from "@notefig/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@notefig/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@notefig/ui/dropdown-menu";
import {
  useRecentProjects,
  deriveProjectName,
} from "@/hooks/use-recent-projects";
import { closeWorkspace, useOpenWorkspaces } from "@/entities/workspaces";
import { useRunningTaskCounts } from "@/entities/agents";
import { pickDirectory } from "@/utils/fs";
import { FsError } from "@/adapters/platform-adapter.interface";
import { workspaceKey } from "@/utils/path";
import { useTranslation } from "react-i18next";

interface WorkspaceSwitcherProps {
  workspacePath: string;
}

const MAX_SWITCHER_ENTRIES = 5;

/** The same chevron glyph @pierre/trees draws on folder rows, so the
 * switcher's affordance matches the tree below it. */
function TreeChevron({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={className}>
      <path
        d="M12.4697 5.46973C12.7626 5.17684 13.2374 5.17684 13.5303 5.46973C13.8232 5.76262 13.8232 6.23738 13.5303 6.53028L8.53028 11.5303C8.23738 11.8232 7.76262 11.8232 7.46973 11.5303L2.46973 6.53028C2.17684 6.23738 2.17684 5.76262 2.46973 5.46973C2.76262 5.17684 3.23738 5.17684 3.53028 5.46973L8 9.93946L12.4697 5.46973Z"
        fill="currentColor"
      />
    </svg>
  );
}

/** One backgrounded workspace in the switcher: name plus the explicit close
 *  affordance (MET-177). Deliberately shows nothing about what is running
 *  inside it — a live-agent indicator here was cut as premature; the only
 *  place running work surfaces is the confirmation on close, where it
 *  changes what the user is about to do. */
function OpenWorkspaceItem({
  path,
  onOpen,
  onClose,
}: {
  path: string;
  onOpen: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <DropdownMenuItem className="group py-1 text-xs" onSelect={onOpen}>
      <span className="truncate">{deriveProjectName(path)}</span>
      <span className="ml-auto flex shrink-0 items-center gap-1.5 ps-2">
        <button
          type="button"
          aria-label={t("closeWorkspaceAction")}
          className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            // Keep the item's onSelect (navigation) out of it.
            event.stopPropagation();
            event.preventDefault();
            onClose();
          }}
        >
          <X className="h-3 w-3" aria-hidden="true" />
        </button>
      </span>
    </DropdownMenuItem>
  );
}

interface PendingClose {
  path: string;
  name: string;
  runningCount: number;
}

/** Confirmation shown only when closing would interrupt running tasks. */
function CloseWorkspaceDialog({
  pending,
  onCancel,
  onConfirm,
}: {
  pending: PendingClose | null;
  onCancel: () => void;
  onConfirm: (path: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <AlertDialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("closeWorkspaceTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("closeWorkspaceBody", {
              name: pending?.name ?? "",
              count: pending?.runningCount ?? 0,
            })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              if (pending) onConfirm(pending.path);
            }}
          >
            {t("closeWorkspaceConfirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Sidebar dropdown for jumping between workspaces. Open (backgrounded)
 * workspaces come from the workspaces entity — switching to one keeps its
 * agents and watchers running, and the ✕ closes it explicitly (MET-177).
 * Recent projects below behave as before: switching records recency and
 * restores the target's saved session URL (the entry redirect in
 * useNavigationPersistence handles the restore).
 */
export function WorkspaceSwitcher({ workspacePath }: WorkspaceSwitcherProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { recentProjects, addRecentProject } = useRecentProjects();
  const openRows = useOpenWorkspaces();
  const runningCounts = useRunningTaskCounts();
  const [pendingClose, setPendingClose] = useState<PendingClose | null>(null);

  const currentKey = workspaceKey(workspacePath);
  const openWorkspaces = openRows.filter((row) => row.key !== currentKey);
  const openKeys = new Set(openRows.map((row) => row.key));

  const otherProjects = recentProjects
    .filter(
      (project) =>
        project.path !== workspacePath &&
        !openKeys.has(workspaceKey(project.path)),
    )
    .slice(0, MAX_SWITCHER_ENTRIES);

  const openProject = (path: string) => {
    addRecentProject(path);
    navigate(`/${encodeURIComponent(path)}`);
  };

  const requestClose = (path: string) => {
    const runningCount = runningCounts.get(workspaceKey(path)) ?? 0;
    if (runningCount === 0) {
      void closeWorkspace(path);
      return;
    }
    setPendingClose({ path, name: deriveProjectName(path), runningCount });
  };

  const handleOpenFolder = async () => {
    try {
      const selectedPath = await pickDirectory("Select a folder");
      if (selectedPath) openProject(selectedPath);
    } catch (error) {
      // null means cancel; a throw means the browser denied the picker.
      if (error instanceof FsError && error.type === "permission_denied") {
        toast.error(t("pickerPermissionDenied"));
      } else {
        throw error;
      }
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className="h-7 min-w-0 gap-1 px-1.5 text-xs font-medium text-muted-foreground focus-visible:ring-0 focus-visible:ring-offset-0"
            aria-label={t("switchWorkspace")}
          >
            <span className="max-w-[8rem] truncate">
              {deriveProjectName(workspacePath)}
            </span>
            <TreeChevron className="h-3 w-3 shrink-0 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-48">
          {openWorkspaces.length > 0 && (
            <>
              <DropdownMenuLabel className="py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                {t("openWorkspacesSection")}
              </DropdownMenuLabel>
              {openWorkspaces.map((row) => (
                <OpenWorkspaceItem
                  key={row.key}
                  path={row.path}
                  onOpen={() => openProject(row.path)}
                  onClose={() => requestClose(row.path)}
                />
              ))}
              <DropdownMenuSeparator />
            </>
          )}
          {otherProjects.map((project) => (
            <DropdownMenuItem
              key={project.path}
              className="py-1 text-xs"
              onSelect={() => openProject(project.path)}
            >
              <span className="truncate">{project.name}</span>
            </DropdownMenuItem>
          ))}
          {otherProjects.length > 0 && <DropdownMenuSeparator />}
          <DropdownMenuItem
            className="py-1 text-xs"
            onSelect={() => void handleOpenFolder()}
          >
            {t("openFolder")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <CloseWorkspaceDialog
        pending={pendingClose}
        onCancel={() => setPendingClose(null)}
        onConfirm={(path) => {
          void closeWorkspace(path);
          setPendingClose(null);
        }}
      />
    </>
  );
}
