import { useState, useEffect } from "react";
import {
  Cloud,
  CloudUpload,
  Type,
  GitCommitHorizontal,
  GitPullRequest,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import {
  getOrCreateWorkspaceGitService,
  gitQueryKeys,
} from "@/utils/git-service-store";
import type { GitError, RepoStatus } from "@metrists/git";

interface StatusBarProps {
  wordCount: number;
  isSynced: boolean;
  direction?: "ltr" | "rtl";
  workspacePath?: string;
}

function useDebouncedSyncState(
  isSynced: boolean,
  delay: number = 300,
): boolean {
  const [debouncedSynced, setDebouncedSynced] = useState(isSynced);

  useEffect(() => {
    if (!isSynced) {
      setDebouncedSynced(false);
    } else {
      const timeout = setTimeout(() => {
        setDebouncedSynced(true);
      }, delay);
      return () => clearTimeout(timeout);
    }
  }, [isSynced, delay]);

  return debouncedSynced;
}

function useGitStatus(workspacePath: string | undefined) {
  return useQuery<RepoStatus, GitError>({
    queryKey: gitQueryKeys(workspacePath ?? "").status,
    queryFn: async () => {
      if (!workspacePath) throw new Error("No workspace");
      const service = getOrCreateWorkspaceGitService(workspacePath);
      return service.status({ repoPath: workspacePath });
    },
    enabled: !!workspacePath,
    retry: false,
    staleTime: 2_000,
    refetchOnWindowFocus: true,
  });
}

export function StatusBar({
  wordCount,
  isSynced,
  direction = "ltr",
  workspacePath,
}: StatusBarProps) {
  const isRtl = direction === "rtl";
  const { t } = useTranslation();
  const debouncedSynced = useDebouncedSyncState(isSynced);
  const { data: gitStatus, isError: gitError } = useGitStatus(workspacePath);

  const hasGitChanges =
    gitStatus &&
    (gitStatus.staged.length > 0 ||
      gitStatus.unstaged.length > 0 ||
      gitStatus.untracked.length > 0);

  const showGit = !!workspacePath && !gitError;

  return (
    <div
      className={cn(
        "fixed bottom-0 flex items-center gap-4 px-4 py-1.5 bg-secondary/80 backdrop-blur-sm border-t border-border text-xs text-muted-foreground",
        isRtl
          ? "left-0 right-auto border-r rounded-tr-lg"
          : "right-0 left-auto border-l rounded-tl-lg",
      )}
    >
      <div className="flex items-center justify-center gap-2 min-w-[4.5rem]">
        {debouncedSynced ? (
          <Cloud className="w-3.5 h-3.5 text-green-500" />
        ) : (
          <CloudUpload className="w-3.5 h-3.5 text-amber-500" />
        )}
        <span>{debouncedSynced ? t("saved") : t("saving")}</span>
      </div>
      {showGit && (
        <div className="flex items-center justify-center gap-2 min-w-[5.5rem]">
          {hasGitChanges ? (
            <GitPullRequest className="w-3.5 h-3.5 text-amber-500" />
          ) : (
            <GitCommitHorizontal className="w-3.5 h-3.5 text-green-500" />
          )}
          <span>{hasGitChanges ? t("unchecked") : t("checked")}</span>
        </div>
      )}
      <div className="flex items-center justify-center gap-2 w-[6.5rem]">
        <Type className="w-3.5 h-3.5" />
        <span>
          {wordCount} {wordCount === 1 ? t("word") : t("words")}
        </span>
      </div>
    </div>
  );
}
