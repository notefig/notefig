import { useMemo, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { ChevronDown, History, Undo2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutateFunction,
} from "@tanstack/react-query";

import type { GitError, GitService } from "@metrists/git";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  getOrCreateWorkspaceGitService,
  initializeWorkspaceGit,
} from "@/utils/git-service-store";

interface CheckpointPanelProps {
  workspacePath: string;
}

interface CheckpointListItem {
  id: string;
  timestamp: Date;
  hash: string;
}

interface RecoveryAction {
  id: "initialize" | "repair" | "retry";
  label: string;
  onClick: () => void;
}

interface QueryState {
  checkpoints: CheckpointListItem[];
  error: GitError | null;
  isLoading: boolean;
}

type MutableT = (key: string, defaultValue: string) => string;

function debugGitTimeline(event: string, details?: unknown): void {
  if (!import.meta.env.DEV) return;

  if (details === undefined) {
    console.debug(`[git-timeline] ${event}`);
    return;
  }

  console.debug(`[git-timeline] ${event}`, details);
}

function gitQueryKeys(workspacePath: string) {
  return {
    status: ["git", workspacePath, "status"] as const,
    checkpoints: ["git", workspacePath, "checkpoints"] as const,
  };
}

function isGitError(value: unknown): value is GitError {
  if (!value || typeof value !== "object") return false;
  return (
    "name" in value &&
    (value as { name: unknown }).name === "GitError" &&
    "code" in value
  );
}

function toGitError(value: unknown): GitError {
  if (isGitError(value)) return value;

  const message =
    value instanceof Error
      ? value.message
      : typeof value === "string"
        ? value
        : "Unknown git error";

  return {
    name: "GitError",
    message,
    code: "CorruptRepository",
  } as GitError;
}

async function loadCheckpointsQuery(
  workspacePath: string,
  service: GitService,
): Promise<CheckpointListItem[]> {
  debugGitTimeline("checkpoints.query.start", { workspacePath });
  const entries = await service.log({ repoPath: workspacePath, depth: 100 });
  debugGitTimeline("checkpoints.query.success", {
    workspacePath,
    count: entries.length,
    head: entries[0]?.oid,
  });

  return entries.map((entry) => ({
    id: entry.oid,
    hash: entry.oid.slice(0, 7),
    timestamp: new Date(entry.commit.committer.timestamp * 1000),
  }));
}

async function saveCheckpointMutation(
  workspacePath: string,
  service: GitService,
  description?: string,
): Promise<string | null> {
  debugGitTimeline("save.mutation.start", {
    workspacePath,
    hasDescription: Boolean(description?.trim()),
  });

  const status = await service.status({ repoPath: workspacePath });
  debugGitTimeline("save.mutation.status", {
    workspacePath,
    staged: status.staged.length,
    unstaged: status.unstaged.length,
    untracked: status.untracked.length,
    branch: status.currentBranch,
  });

  const changedPaths = new Set<string>([
    ...status.untracked,
    ...status.unstaged.map((item) => item.path),
    ...status.staged.map((item) => item.path),
  ]);

  if (changedPaths.size === 0) {
    debugGitTimeline("save.mutation.noop", { workspacePath });
    return null;
  }

  debugGitTimeline("save.mutation.stage", {
    workspacePath,
    count: changedPaths.size,
    paths: Array.from(changedPaths),
  });

  for (const path of changedPaths) {
    await service.add({ repoPath: workspacePath, filepath: path });
  }

  const message = description?.trim() || "Checkpoint";

  const oid = await service.commit({
    repoPath: workspacePath,
    message,
    author: {
      name: "Metrists",
      email: "checkpoints@metrists.local",
    },
  });

  debugGitTimeline("save.mutation.success", { workspacePath, oid });

  return oid;
}

function getErrorPresentation(
  error: GitError,
  t: MutableT,
): { title: string; message: string } {
  switch (error.code) {
    case "RepoNotFound":
      return {
        title: t("timelineNotInitializedTitle", "Timeline not initialized"),
        message: t(
          "timelineNotInitializedMessage",
          "Project timeline is not initialized.",
        ),
      };
    case "LockUnavailable":
      return {
        title: t("timelineBusyTitle", "Timeline is busy"),
        message: t("timelineBusyMessage", "Project timeline is busy."),
      };
    case "CorruptRepository":
      return {
        title: t("timelineCorruptTitle", "Timeline needs repair"),
        message: t(
          "timelineCorruptMessage",
          "Project timeline metadata is inconsistent.",
        ),
      };
    case "UnsupportedOperation":
      return {
        title: t("timelineUnsupportedTitle", "Action unavailable"),
        message: t(
          "timelineUnsupportedMessage",
          "This action is not available in this environment.",
        ),
      };
    case "InvalidInput":
      return {
        title: t("timelineInvalidInputTitle", "Invalid input"),
        message: error.message,
      };
    default:
      return {
        title: t("timelineUnexpectedTitle", "Timeline error"),
        message: error.message,
      };
  }
}

export function CheckpointPanel({ workspacePath }: CheckpointPanelProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [autoSaveEnabled, setAutoSaveEnabled] = useState(false);
  const [description, setDescription] = useState("");

  const service = useMemo(
    () => getOrCreateWorkspaceGitService(workspacePath),
    [workspacePath],
  );

  const keys = useMemo(() => gitQueryKeys(workspacePath), [workspacePath]);

  const checkpointsQuery = useQuery<CheckpointListItem[], GitError>({
    queryKey: keys.checkpoints,
    queryFn: async () => {
      try {
        return await loadCheckpointsQuery(workspacePath, service);
      } catch (error) {
        const gitError = toGitError(error);
        debugGitTimeline("checkpoints.query.error", {
          workspacePath,
          code: gitError.code,
          message: gitError.message,
          raw: error,
        });
        throw gitError;
      }
    },
    retry: false,
  });

  useQuery({
    queryKey: keys.status,
    queryFn: async () => {
      debugGitTimeline("status.query.start", { workspacePath });
      try {
        const status = await service.status({ repoPath: workspacePath });
        debugGitTimeline("status.query.success", {
          workspacePath,
          branch: status.currentBranch,
          staged: status.staged.length,
          unstaged: status.unstaged.length,
          untracked: status.untracked.length,
        });
        return status;
      } catch (error) {
        const gitError = toGitError(error);
        debugGitTimeline("status.query.error", {
          workspacePath,
          code: gitError.code,
          message: gitError.message,
          raw: error,
        });
        throw gitError;
      }
    },
    retry: false,
  });

  const saveCheckpoint = useMutation<
    string | null,
    GitError,
    string | undefined
  >({
    mutationFn: async (value) => {
      try {
        return await saveCheckpointMutation(workspacePath, service, value);
      } catch (error) {
        const gitError = toGitError(error);
        debugGitTimeline("save.mutation.error", {
          workspacePath,
          code: gitError.code,
          message: gitError.message,
          raw: error,
        });
        throw gitError;
      }
    },
    onSuccess: () => {
      debugGitTimeline("save.mutation.invalidate", { workspacePath });
      void queryClient.invalidateQueries({ queryKey: keys.checkpoints });
      void queryClient.invalidateQueries({ queryKey: keys.status });
    },
  });

  const initializeTimeline = useMutation<void, GitError, void>({
    mutationFn: async () => {
      debugGitTimeline("initialize.mutation.start", { workspacePath });
      try {
        await initializeWorkspaceGit(workspacePath);
        debugGitTimeline("initialize.mutation.success", { workspacePath });
      } catch (error) {
        const gitError = toGitError(error);
        debugGitTimeline("initialize.mutation.error", {
          workspacePath,
          code: gitError.code,
          message: gitError.message,
          raw: error,
        });
        throw gitError;
      }
    },
    onSuccess: () => {
      debugGitTimeline("initialize.mutation.invalidate", { workspacePath });
      void queryClient.invalidateQueries({ queryKey: keys.checkpoints });
      void queryClient.invalidateQueries({ queryKey: keys.status });
    },
  });

  const combinedError =
    checkpointsQuery.error ??
    saveCheckpoint.error ??
    initializeTimeline.error ??
    null;

  const state: QueryState = {
    checkpoints: checkpointsQuery.data ?? [],
    error: combinedError,
    isLoading:
      checkpointsQuery.isLoading ||
      saveCheckpoint.isPending ||
      initializeTimeline.isPending,
  };

  const runRetry = () => {
    void checkpointsQuery.refetch();
    void queryClient.invalidateQueries({ queryKey: keys.status });
  };

  const errorActions =
    state.error === null
      ? []
      : getRecoveryActions({
          error: state.error,
          t,
          retry: runRetry,
          initialize: initializeTimeline.mutate,
        });

  if (state.error) {
    debugGitTimeline("panel.error.active", {
      workspacePath,
      code: state.error.code,
      message: state.error.message,
    });
  }

  return (
    <div className="flex h-full flex-col">
      <QuickSaveCheckpoint
        isSaving={saveCheckpoint.isPending}
        autoSaveEnabled={autoSaveEnabled}
        onAutoSaveToggle={setAutoSaveEnabled}
        description={description}
        onDescriptionChange={setDescription}
        onSave={(value) => saveCheckpoint.mutate(value)}
        t={t}
      />

      {state.error ? (
        <RecoveryBanner error={state.error} actions={errorActions} t={t} />
      ) : null}

      <CheckpointsList
        checkpoints={state.checkpoints}
        isLoading={state.isLoading}
        t={t}
      />
    </div>
  );
}

function getRecoveryActions({
  error,
  t,
  retry,
  initialize,
}: {
  error: GitError;
  t: MutableT;
  retry: () => void;
  initialize: UseMutateFunction<void, GitError, void, unknown>;
}): RecoveryAction[] {
  switch (error.code) {
    case "RepoNotFound":
      return [
        {
          id: "initialize",
          label: t("initializeTimeline", "Initialize timeline"),
          onClick: () => initialize(),
        },
      ];
    case "CorruptRepository":
      return [
        {
          id: "repair",
          label: t("repairTimeline", "Repair timeline"),
          onClick: () => initialize(),
        },
      ];
    case "LockUnavailable":
      return [
        {
          id: "retry",
          label: t("retry", "Retry"),
          onClick: retry,
        },
      ];
    default:
      return [
        {
          id: "retry",
          label: t("retry", "Retry"),
          onClick: retry,
        },
      ];
  }
}

interface RecoveryBannerProps {
  error: GitError;
  actions: RecoveryAction[];
  t: MutableT;
}

function RecoveryBanner({ error, actions, t }: RecoveryBannerProps) {
  const content = getErrorPresentation(error, t);

  return (
    <div className="mx-4 mb-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2">
      <div className="text-xs font-semibold text-destructive">
        {content.title}
      </div>
      <div className="mt-0.5 text-xs text-destructive/80">
        {content.message}
      </div>
      <div className="mt-2 flex gap-2">
        {actions.map((action) => (
          <Button
            key={action.id}
            variant="outline"
            size="sm"
            className="h-6 border-destructive/30 text-[11px] text-destructive hover:bg-destructive/10"
            onClick={action.onClick}
          >
            {action.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

interface QuickSaveCheckpointProps {
  isSaving?: boolean;
  autoSaveEnabled: boolean;
  onAutoSaveToggle: (enabled: boolean) => void;
  description: string;
  onDescriptionChange: (value: string) => void;
  onSave: (description?: string) => void;
  t: MutableT;
}

function QuickSaveCheckpoint({
  isSaving = false,
  autoSaveEnabled,
  onAutoSaveToggle,
  description,
  onDescriptionChange,
  onSave,
  t,
}: QuickSaveCheckpointProps) {
  const [open, setOpen] = useState(false);

  const saveQuick = () => {
    onSave(undefined);
    setOpen(false);
  };

  const saveWithDescription = () => {
    onSave(description.trim() ? description : undefined);
    setOpen(false);
  };

  return (
    <div className="flex items-center px-4 py-2">
      <ButtonGroup>
        <Button
          size="sm"
          variant="ghost"
          className="h-8 min-w-32 px-3 text-xs"
          disabled={isSaving}
          onClick={saveQuick}
        >
          {isSaving
            ? t("checkpointSaving", "Saving checkpoint...")
            : t("saveCheckpoint", "Save checkpoint")}
        </Button>

        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              className="h-8 w-10 p-0"
              aria-label={t(
                "saveCheckpointWithDescription",
                "Save checkpoint with description",
              )}
              disabled={isSaving}
              variant="ghost"
            >
              <ChevronDown className="size-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent side="bottom" align="start" className="w-80">
            <div className="flex flex-col gap-3">
              <div className="space-y-1.5">
                <h4 className="text-sm font-medium">
                  {t(
                    "saveCheckpointWithDescription",
                    "Save checkpoint with description",
                  )}
                </h4>
                <p className="text-xs text-muted-foreground">
                  {t(
                    "checkpointDescriptionHint",
                    "Add a brief description of what changed",
                  )}
                </p>
              </div>

              <div className="flex gap-2">
                <Input
                  placeholder={t(
                    "checkpointDescriptionPlaceholder",
                    "What changed?",
                  )}
                  value={description}
                  onChange={(event) => onDescriptionChange(event.target.value)}
                  className="h-8 text-sm"
                />
                <Button
                  size="sm"
                  className="h-8 shrink-0 text-xs"
                  onClick={saveWithDescription}
                  disabled={isSaving}
                >
                  {t("saveCheckpoint", "Save checkpoint")}
                </Button>
              </div>

              <Separator className="my-1" />

              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-medium">
                    {t("autoSaveCheckpoints", "Auto-save checkpoints")}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {t("autoSaveCheckpointsHint", "After each change")}
                  </p>
                </div>
                <Switch
                  checked={autoSaveEnabled}
                  onCheckedChange={onAutoSaveToggle}
                />
              </div>
            </div>
          </PopoverContent>
        </Popover>
      </ButtonGroup>
    </div>
  );
}

interface CheckpointsListProps {
  checkpoints: CheckpointListItem[];
  isLoading?: boolean;
  t: MutableT;
}

function CheckpointsList({
  checkpoints,
  isLoading = false,
  t,
}: CheckpointsListProps) {
  if (isLoading && checkpoints.length === 0) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="text-center text-sm text-muted-foreground">
          {t("loadingTimeline", "Loading timeline...")}
        </div>
      </div>
    );
  }

  if (checkpoints.length === 0) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="text-center text-sm text-muted-foreground">
          {t("noCheckpointsYet", "No checkpoints yet. Save your first one!")}
        </div>
      </div>
    );
  }

  return (
    <ScrollArea className="flex-1 min-h-0">
      <div className="flex flex-col" role="list">
        <div className="px-4 py-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t("checkpoints", "Checkpoints")}
          </p>
        </div>
        {checkpoints.map((checkpoint, index) => (
          <div
            key={checkpoint.id}
            className="flex items-center justify-between gap-2 px-4 py-1.5 transition-colors hover:bg-muted/50"
            role="listitem"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <time
                  className="text-[11px] text-muted-foreground"
                  dateTime={checkpoint.timestamp.toISOString()}
                >
                  {formatDistanceToNow(checkpoint.timestamp, {
                    addSuffix: true,
                  })}
                </time>
                {index === 0 ? (
                  <span className="inline-flex h-4 items-center rounded-md bg-secondary px-1.5 text-[10px] text-secondary-foreground">
                    {t("latest", "Latest")}
                  </span>
                ) : null}
              </div>
              <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                {checkpoint.hash}
              </div>
            </div>

            <CheckpointActions disabled t={t} />
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}

interface CheckpointActionsProps {
  disabled?: boolean;
  t: MutableT;
}

function CheckpointActions({ disabled = false, t }: CheckpointActionsProps) {
  return (
    <div className="flex items-center gap-0.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground"
            aria-label={t("compareCheckpoint", "Compare checkpoint")}
            disabled
          >
            <History className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="left">
          {t("compareCheckpoint", "Compare checkpoint")}
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground"
            aria-label={t("restoreCheckpoint", "Restore checkpoint")}
            disabled={disabled}
          >
            <Undo2 className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="left">
          {t("restoreCheckpoint", "Restore checkpoint")}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
