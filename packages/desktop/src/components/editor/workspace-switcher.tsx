"use client";

import { useNavigate } from "react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  useRecentProjects,
  deriveProjectName,
} from "@/hooks/use-recent-projects";
import { pickDirectory } from "@/utils/fs";
import { FsError } from "@/adapters/platform-adapter.interface";
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

/**
 * Sidebar dropdown for jumping between workspaces. Backed by the same
 * recent-projects rows as the welcome screen, so switching here records
 * recency and restores the target project's saved session URL (the entry
 * redirect in useNavigationPersistence handles the restore).
 */
export function WorkspaceSwitcher({ workspacePath }: WorkspaceSwitcherProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { recentProjects, addRecentProject } = useRecentProjects();

  const otherProjects = recentProjects
    .filter((project) => project.path !== workspacePath)
    .slice(0, MAX_SWITCHER_ENTRIES);

  const openProject = (path: string) => {
    addRecentProject(path);
    navigate(`/${encodeURIComponent(path)}`);
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
      <DropdownMenuContent align="start" className="w-40">
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
  );
}
