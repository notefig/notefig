import { useMemo, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import {
  Check,
  ChevronDown,
  CloudUpload,
  GitCommitHorizontal,
  History,
  TriangleAlert,
  Undo2,
} from "lucide-react";
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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
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
  message: string;
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

type SyncState = "uncommitted" | "unsynced" | "synced";

type MutableT = (key: string, defaultValue: string) => string;

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

async function loadCheckpointsQuery(
  workspacePath: string,
  service: GitService,
): Promise<CheckpointListItem[]> {
  const entries = await service.log({ repoPath: workspacePath, depth: 100 });

  return entries.map((entry) => ({
    id: entry.oid,
    hash: entry.oid.slice(0, 7),
    timestamp: new Date(entry.commit.committer.timestamp * 1000),
    message: entry.commit.message.split("\n")[0] || "Checkpoint",
  }));
}

async function saveCheckpointMutation(
  workspacePath: string,
  service: GitService,
  description?: string,
): Promise<string | null> {
  const status = await service.status({ repoPath: workspacePath });

  const changedPaths = new Set<string>([
    ...status.untracked,
    ...status.unstaged.map((item) => item.path),
    ...status.staged.map((item) => item.path),
  ]);

  if (changedPaths.size === 0) {
    return null;
  }

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

function deriveSyncState(
  status: {
    staged: unknown[];
    unstaged: unknown[];
    untracked: unknown[];
    ahead?: number;
  } | null,
): SyncState {
  if (!status) {
    return "synced";
  }

  if (
    status.staged.length > 0 ||
    status.unstaged.length > 0 ||
    status.untracked.length > 0
  ) {
    return "uncommitted";
  }

  if ((status.ahead ?? 0) > 0) {
    return "unsynced";
  }

  return "synced";
}

function getSyncStatePresentation(
  state: SyncState,
  t: MutableT,
): {
  label: string;
  Icon: typeof TriangleAlert;
} {
  switch (state) {
    case "uncommitted":
      return {
        label: t("timelineStateUncommitted", "Uncommitted"),
        Icon: TriangleAlert,
      };
    case "unsynced":
      return {
        label: t("timelineStateUnsynced", "Not synced"),
        Icon: CloudUpload,
      };
    default:
      return {
        label: t("timelineStateSynced", "Synced"),
        Icon: Check,
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
    queryFn: async () => loadCheckpointsQuery(workspacePath, service),
    retry: false,
  });

  const statusQuery = useQuery({
    queryKey: keys.status,
    queryFn: async () => service.status({ repoPath: workspacePath }),
    retry: false,
  });

  const saveCheckpoint = useMutation<
    string | null,
    GitError,
    string | undefined
  >({
    mutationFn: async (value) =>
      saveCheckpointMutation(workspacePath, service, value),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.checkpoints });
      void queryClient.invalidateQueries({ queryKey: keys.status });
    },
  });

  const initializeTimeline = useMutation<void, GitError, void>({
    mutationFn: async () => {
      await initializeWorkspaceGit(workspacePath);
    },
    onSuccess: () => {
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

  const syncState = deriveSyncState(statusQuery.data ?? null);

  return (
    <div className="flex h-full flex-col">
      <QuickSaveCheckpoint
        isSaving={saveCheckpoint.isPending}
        autoSaveEnabled={autoSaveEnabled}
        onAutoSaveToggle={setAutoSaveEnabled}
        description={description}
        onDescriptionChange={setDescription}
        onSave={(value) => saveCheckpoint.mutate(value)}
        syncState={syncState}
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
  syncState: SyncState;
  t: MutableT;
}

function QuickSaveCheckpoint({
  isSaving = false,
  autoSaveEnabled,
  onAutoSaveToggle,
  description,
  onDescriptionChange,
  onSave,
  syncState,
  t,
}: QuickSaveCheckpointProps) {
  const [open, setOpen] = useState(false);
  const syncPresentation = getSyncStatePresentation(syncState, t);

  const saveQuick = () => {
    onSave(undefined);
    setOpen(false);
  };

  const saveWithDescription = () => {
    onSave(description.trim() ? description : undefined);
    setOpen(false);
  };

  return (
    <div className="flex h-[2.6rem] items-center justify-between border-b border-sidebar-border bg-sidebar px-2">
      <ButtonGroup>
        <Button
          type="button"
          variant="ghost"
          className="h-6 gap-1 px-1.5 text-xs text-muted-foreground focus-visible:ring-0 focus-visible:ring-offset-0 [&_svg]:size-3.5"
          disabled={isSaving}
          onClick={saveQuick}
          aria-label={t("saveCheckpoint", "Save checkpoint")}
        >
          <GitCommitHorizontal className="h-3.5 w-3.5" />
          <span className="truncate">
            {isSaving
              ? t("checkpointSaving", "Saving checkpoint...")
              : t("saveCheckpoint", "Save checkpoint")}
          </span>
        </Button>

        <Popover open={open} onOpenChange={setOpen}>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-muted-foreground focus-visible:ring-0 focus-visible:ring-offset-0 [&_svg]:size-3.5"
                  aria-label={t(
                    "saveCheckpointWithDescription",
                    "Save checkpoint with description",
                  )}
                  disabled={isSaving}
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                  <span className="sr-only">
                    {t(
                      "saveCheckpointWithDescription",
                      "Save checkpoint with description",
                    )}
                  </span>
                </Button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="px-2 py-1 text-[11px]">
              {t(
                "saveCheckpointWithDescription",
                "Save checkpoint with description",
              )}
            </TooltipContent>
          </Tooltip>
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

              <div className="space-y-2">
                <Textarea
                  placeholder={t(
                    "checkpointDescriptionPlaceholder",
                    "What changed?",
                  )}
                  value={description}
                  onChange={(event) => onDescriptionChange(event.target.value)}
                  className="min-h-[84px] resize-none text-sm"
                />
                <div className="flex justify-end">
                  <Button
                    type="button"
                    size="sm"
                    className="h-8 shrink-0 text-xs"
                    onClick={saveWithDescription}
                    disabled={isSaving}
                  >
                    {t("saveCheckpoint", "Save checkpoint")}
                  </Button>
                </div>
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

      <span className="inline-flex h-6 max-w-24 min-w-0 items-center gap-1 overflow-hidden rounded-md border px-1.5 text-[11px] leading-none">
        <syncPresentation.Icon className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 truncate">{syncPresentation.label}</span>
      </span>
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
        {checkpoints.map((checkpoint, index) => (
          <div
            key={checkpoint.id}
            className="flex items-center justify-between gap-2 py-1.5 pl-4 pr-1 transition-colors hover:bg-muted/50"
            role="listitem"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                {checkpoint.message ? (
                  <span className="truncate text-[11px] font-medium">
                    {checkpoint.message}
                  </span>
                ) : (
                  <time
                    className="truncate text-[11px] text-muted-foreground"
                    dateTime={checkpoint.timestamp.toISOString()}
                  >
                    {formatDistanceToNow(checkpoint.timestamp, {
                      addSuffix: true,
                    })}
                  </time>
                )}
                {index === 0 ? (
                  <span className="inline-flex h-4 max-w-16 shrink-0 items-center truncate whitespace-nowrap rounded-md bg-secondary px-1.5 text-[10px] text-secondary-foreground">
                    {t("latest", "Latest")}
                  </span>
                ) : null}
              </div>
              <div className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">
                <button
                  type="button"
                  className="h-auto w-auto p-0 font-mono leading-none hover:text-foreground"
                  onClick={() =>
                    void navigator.clipboard.writeText(checkpoint.hash)
                  }
                  aria-label={t("copyCommitHash", "Copy commit hash")}
                >
                  {checkpoint.hash}
                </button>
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
            className="h-6 w-6 text-muted-foreground [&_svg]:size-3.5"
            aria-label={t("compareCheckpoint", "Compare checkpoint")}
            disabled
          >
            <History className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="left" className="px-2 py-1 text-[11px]">
          {t("compareCheckpoint", "Compare checkpoint")}
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-muted-foreground [&_svg]:size-3.5"
            aria-label={t("restoreCheckpoint", "Restore checkpoint")}
            disabled={disabled}
          >
            <Undo2 className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="left" className="px-2 py-1 text-[11px]">
          {t("restoreCheckpoint", "Restore checkpoint")}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
