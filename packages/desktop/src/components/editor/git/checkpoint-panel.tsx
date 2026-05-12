import { useEffect, useMemo, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import {
  Check,
  ChevronDown,
  CircleDashed,
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

import type { GitError, GitService, RepoStatus } from "@metrists/git";
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
  id: "initialize" | "repair" | "retry" | "abort" | "dismiss";
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

interface QueryState {
  checkpoints: CheckpointListItem[];
  error: GitError | null;
}

interface SaveCheckpointMutationContext {
  previousCheckpoints: CheckpointListItem[];
  optimisticId: string;
}

type SyncState = "uncommitted" | "unsynced" | "synced";

type PanelState = "uninitialized" | "error" | "empty" | "ready";

type MutableT = (key: string, defaultValue: string) => string;

function gitQueryKeys(workspacePath: string) {
  return {
    status: ["git", workspacePath, "status"] as const,
    checkpoints: ["git", workspacePath, "checkpoints"] as const,
  };
}

function isRepoNotFoundError(error: GitError | null | undefined): boolean {
  return error?.code === "RepoNotFound";
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
    message: entry.commit.message.split("\n")[0] || "Commit",
  }));
}

async function saveCheckpointMutation(
  workspacePath: string,
  service: GitService,
  description?: string,
): Promise<string | null> {
  return service.addAllAndCommit({
    repoPath: workspacePath,
    message: description?.trim() || "Commit",
    author: {
      name: "Metrists",
      email: "git@metrists.com",
    },
  });
}

function getErrorPresentation(
  error: GitError,
  t: MutableT,
): { title: string; message: string } {
  switch (error.code) {
    case "RepoNotFound":
      return {
        title: t(
          "timelineNotInitializedTitle",
          "Commit history not initialized",
        ),
        message: t(
          "timelineNotInitializedMessage",
          "Project commit history is not initialized.",
        ),
      };
    case "LockUnavailable":
      return {
        title: t("timelineBusyTitle", "Commit history is busy"),
        message: t("timelineBusyMessage", "Project commit history is busy."),
      };
    case "CorruptRepository":
      return {
        title: t("timelineCorruptTitle", "Commit history needs repair"),
        message: t(
          "timelineCorruptMessage",
          "Project commit history metadata is inconsistent.",
        ),
      };
    case "MergeRequired":
      return {
        title: t("timelineMergeRequiredTitle", "Revert needs attention"),
        message: t(
          "timelineMergeRequiredMessage",
          "Revert would conflict with current changes.",
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
        title: t("timelineUnexpectedTitle", "Commit history error"),
        message: error.message,
      };
  }
}

function derivePanelState({
  status,
  statusError,
  checkpointsError,
  initializeError,
  checkpoints,
}: {
  status: RepoStatus | undefined;
  statusError: GitError | null;
  checkpointsError: GitError | null;
  initializeError: GitError | null;
  checkpoints: CheckpointListItem[];
}): PanelState {
  if (isRepoNotFoundError(statusError) && !status && checkpoints.length === 0) {
    return "uninitialized";
  }

  if (initializeError || checkpointsError || statusError) {
    return "error";
  }

  if (checkpoints.length === 0) {
    return "empty";
  }

  return "ready";
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
        label: t("timelineStateUncommitted", "Unchecked"),
        Icon: CircleDashed,
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
  const [stablePanelState, setStablePanelState] = useState<PanelState | null>(
    null,
  );
  const [revertError, setRevertError] = useState<GitError | null>(null);
  const [activeRevertId, setActiveRevertId] = useState<string | null>(null);

  const service = useMemo(
    () => getOrCreateWorkspaceGitService(workspacePath),
    [workspacePath],
  );

  const commitAuthor = useMemo(
    () => ({ name: "Metrists", email: "git@metrists.com" }),
    [],
  );

  const keys = useMemo(() => gitQueryKeys(workspacePath), [workspacePath]);

  const statusQuery = useQuery<RepoStatus, GitError>({
    queryKey: keys.status,
    queryFn: async () => service.status({ repoPath: workspacePath }),
    retry: false,
    staleTime: 1_000,
    refetchInterval: 2_000,
    refetchIntervalInBackground: false,
  });

  const checkpointsQuery = useQuery<CheckpointListItem[], GitError>({
    queryKey: keys.checkpoints,
    queryFn: async () => loadCheckpointsQuery(workspacePath, service),
    retry: false,
    staleTime: 5_000,
    enabled: !isRepoNotFoundError(statusQuery.error),
    placeholderData: (previous) => previous,
  });

  const saveCheckpoint = useMutation<
    string | null,
    GitError,
    string | undefined,
    SaveCheckpointMutationContext
  >({
    mutationFn: async (value) =>
      saveCheckpointMutation(workspacePath, service, value),
    onMutate: async (value) => {
      await queryClient.cancelQueries({ queryKey: keys.checkpoints });

      const previousCheckpoints =
        queryClient.getQueryData<CheckpointListItem[]>(keys.checkpoints) ?? [];
      const optimisticId = `optimistic-${Date.now()}`;

      const optimisticEntry: CheckpointListItem = {
        id: optimisticId,
        hash: "pending",
        timestamp: new Date(),
        message: value?.trim() || "Commit",
      };

      queryClient.setQueryData<CheckpointListItem[]>(keys.checkpoints, [
        optimisticEntry,
        ...previousCheckpoints,
      ]);

      return { previousCheckpoints, optimisticId };
    },
    onError: (_error, _value, context) => {
      if (!context) return;
      queryClient.setQueryData(keys.checkpoints, context.previousCheckpoints);
    },
    onSuccess: (oid, _value, context) => {
      if (!context) return;

      if (!oid) {
        queryClient.setQueryData(keys.checkpoints, context.previousCheckpoints);
        return;
      }

      queryClient.setQueryData<CheckpointListItem[] | undefined>(
        keys.checkpoints,
        (current) => {
          if (!current) return current;
          return current.map((item) =>
            item.id === context.optimisticId
              ? {
                  ...item,
                  id: oid,
                  hash: oid.slice(0, 7),
                }
              : item,
          );
        },
      );

      void queryClient.invalidateQueries({ queryKey: keys.checkpoints });
      void queryClient.invalidateQueries({ queryKey: keys.status });
    },
    onSettled: async () => {
      await queryClient.refetchQueries({
        queryKey: keys.status,
        type: "active",
      });
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

  const statusError = statusQuery.error ?? null;
  const checkpointsError = checkpointsQuery.error ?? null;
  const initializeError = initializeTimeline.error ?? null;
  const effectiveStatusError = statusQuery.data ? null : statusError;

  const panelState = derivePanelState({
    status: statusQuery.data,
    statusError: effectiveStatusError,
    checkpointsError,
    initializeError,
    checkpoints: checkpointsQuery.data ?? [],
  });

  const isBackgroundFetching =
    statusQuery.isFetching || checkpointsQuery.isFetching;

  useEffect(() => {
    if (stablePanelState === null) {
      setStablePanelState(panelState);
      return;
    }

    if (!isBackgroundFetching) {
      setStablePanelState(panelState);
    }
  }, [panelState, isBackgroundFetching, stablePanelState]);

  const renderPanelState = stablePanelState ?? panelState;

  const state: QueryState = {
    checkpoints: checkpointsQuery.data ?? [],
    error:
      renderPanelState === "error"
        ? (initializeError ?? checkpointsError ?? effectiveStatusError)
        : null,
  };

  const runRetry = () => {
    if (renderPanelState !== "uninitialized") {
      void checkpointsQuery.refetch();
    }
    void statusQuery.refetch();
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
  const hasChanges = Boolean(
    statusQuery.data &&
    (statusQuery.data.staged.length > 0 ||
      statusQuery.data.unstaged.length > 0 ||
      statusQuery.data.untracked.length > 0),
  );
  const canSave = renderPanelState !== "uninitialized" && hasChanges;

  const revertCommit = useMutation<string | null, GitError, CheckpointListItem>(
    {
      mutationFn: async (checkpoint) => {
        console.log(
          "[checkpoint-panel] revertCommit mutationFn starting for",
          checkpoint.hash,
        );
        const status = await service.status({ repoPath: workspacePath });
        const hasLocalChanges =
          status.staged.length > 0 ||
          status.unstaged.length > 0 ||
          status.untracked.length > 0;

        if (hasLocalChanges) {
          console.log(
            "[checkpoint-panel] auto-committing local changes before revert",
          );
          await service.addAllAndCommit({
            repoPath: workspacePath,
            message: `WIP before revert ${checkpoint.hash}`,
            author: commitAuthor,
          });
        }

        const result = await service.revertCommit({
          repoPath: workspacePath,
          oid: checkpoint.id,
          message: `Revert ${checkpoint.hash}`,
          author: commitAuthor,
        });
        console.log(
          "[checkpoint-panel] revertCommit mutationFn completed",
          result,
        );
        return result;
      },
      onMutate: (checkpoint) => {
        console.log(
          "[checkpoint-panel] revertCommit onMutate",
          checkpoint.hash,
        );
        setRevertError(null);
        setActiveRevertId(checkpoint.id);
      },
      onSuccess: async () => {
        console.log("[checkpoint-panel] revertCommit onSuccess");
        setRevertError(null);
        await queryClient.invalidateQueries({ queryKey: keys.checkpoints });
        await queryClient.invalidateQueries({ queryKey: keys.status });
      },
      onError: (error) => {
        console.error(
          "[checkpoint-panel] revertCommit failed:",
          error.code,
          error.message,
        );
        setRevertError(error);
      },
      onSettled: () => {
        console.log("[checkpoint-panel] revertCommit onSettled");
        setActiveRevertId(null);
      },
    },
  );

  const abortRevert = useMutation<void, GitError, void>({
    mutationFn: async () => {
      console.log("[checkpoint-panel] abortRevert mutationFn starting");
      await service.abortRevert({ repoPath: workspacePath });
      console.log("[checkpoint-panel] abortRevert mutationFn completed");
    },
    onMutate: () => {
      console.log("[checkpoint-panel] abortRevert onMutate");
    },
    onSuccess: async () => {
      console.log("[checkpoint-panel] abortRevert onSuccess");
      setRevertError(null);
      await queryClient.invalidateQueries({ queryKey: keys.status });
    },
    onError: (error) => {
      console.error("[checkpoint-panel] abortRevert failed:", error);
    },
    onSettled: () => {
      console.log("[checkpoint-panel] abortRevert onSettled");
    },
  });

  const revertActions: RecoveryAction[] = useMemo(() => {
    if (!revertError) return [];
    if (revertError.code === "MergeRequired") {
      return [
        {
          id: "abort",
          label: t("abortRevert", "Abort revert"),
          onClick: () => {
            console.log("[checkpoint-panel] Abort revert clicked");
            abortRevert.mutate();
          },
          disabled: abortRevert.isPending,
        },
      ];
    }

    return [
      {
        id: "dismiss",
        label: t("dismiss", "Dismiss"),
        onClick: () => setRevertError(null),
      },
    ];
  }, [abortRevert, revertError, t]);

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
        canSave={canSave}
        t={t}
      />

      {revertError ? (
        <RecoveryBanner error={revertError} actions={revertActions} t={t} />
      ) : null}

      <CheckpointsList
        panelState={renderPanelState}
        checkpoints={state.checkpoints}
        isReverting={revertCommit.isPending}
        activeRevertId={activeRevertId}
        onRevert={(checkpoint: CheckpointListItem) =>
          revertCommit.mutate(checkpoint)
        }
        actions={
          renderPanelState === "uninitialized"
            ? [
                {
                  id: "initialize",
                  label: t("initializeTimeline", "Initialize commit history"),
                  onClick: () => initializeTimeline.mutate(),
                },
              ]
            : renderPanelState === "empty"
              ? [
                  {
                    id: "retry",
                    label: t("saveCheckpoint", "Save commit"),
                    onClick: () => saveCheckpoint.mutate(undefined),
                    disabled: !canSave || saveCheckpoint.isPending,
                  },
                ]
              : errorActions
        }
        message={
          renderPanelState === "uninitialized"
            ? t(
                "timelineNotInitializedMessage",
                "Project commit history is not initialized.",
              )
            : renderPanelState === "empty"
              ? t("noCheckpointsYet", "No commits yet. Save your first one!")
              : state.error
                ? getErrorPresentation(state.error, t).message
                : null
        }
        isError={renderPanelState === "error"}
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
          label: t("initializeTimeline", "Initialize commit history"),
          onClick: () => initialize(),
        },
      ];
    case "CorruptRepository":
      return [
        {
          id: "repair",
          label: t("repairTimeline", "Repair commit history"),
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
            disabled={action.disabled}
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
  canSave: boolean;
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
  canSave,
  t,
}: QuickSaveCheckpointProps) {
  const [open, setOpen] = useState(false);
  const syncPresentation = getSyncStatePresentation(syncState, t);

  const saveQuick = () => {
    onSave(undefined);
    onDescriptionChange("");
    setOpen(false);
  };

  const saveWithDescription = () => {
    onSave(description.trim() ? description : undefined);
    onDescriptionChange("");
    setOpen(false);
  };

  return (
    <div className="flex h-[2.6rem] items-center justify-between border-b border-sidebar-border bg-sidebar px-2">
      <ButtonGroup>
        <Button
          type="button"
          variant="ghost"
          className="h-6 gap-1 px-1.5 text-xs text-muted-foreground focus-visible:ring-0 focus-visible:ring-offset-0 [&_svg]:size-3.5"
          disabled={isSaving || !canSave}
          onClick={saveQuick}
          aria-label={t("saveCheckpoint", "Save commit")}
        >
          <GitCommitHorizontal className="h-3.5 w-3.5" />
          <span className="truncate">
            {isSaving
              ? t("checkpointSaving", "Saving commit...")
              : t("saveCheckpoint", "Save commit")}
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
                    "Save commit with description",
                  )}
                  disabled={isSaving}
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                  <span className="sr-only">
                    {t(
                      "saveCheckpointWithDescription",
                      "Save commit with description",
                    )}
                  </span>
                </Button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="px-2 py-1 text-[11px]">
              {t(
                "saveCheckpointWithDescription",
                "Save commit with description",
              )}
            </TooltipContent>
          </Tooltip>
          <PopoverContent side="bottom" align="start" className="w-80">
            <div className="flex flex-col gap-3">
              <div className="space-y-1.5">
                <h4 className="text-sm font-medium">
                  {t(
                    "saveCheckpointWithDescription",
                    "Save commit with description",
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
                    disabled={isSaving || !canSave}
                  >
                    {t("saveCheckpoint", "Save commit")}
                  </Button>
                </div>
              </div>

              <Separator className="my-1" />

              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-medium">
                    {t("autoSaveCheckpoints", "Auto-save commits")}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {t("autoSaveCheckpointsHint", "After each change")}
                  </p>
                </div>
                <Switch
                  checked={autoSaveEnabled}
                  onCheckedChange={onAutoSaveToggle}
                  disabled
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
  panelState: PanelState;
  checkpoints: CheckpointListItem[];
  actions: RecoveryAction[];
  message: string | null;
  isError: boolean;
  t: MutableT;
  onRevert: (checkpoint: CheckpointListItem) => void;
  isReverting: boolean;
  activeRevertId: string | null;
}

function CheckpointsList({
  panelState,
  checkpoints,
  actions,
  message,
  isError,
  t,
  onRevert,
  isReverting,
  activeRevertId,
}: CheckpointsListProps) {
  if (panelState === "uninitialized" || panelState === "empty" || isError) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="space-y-3 text-center">
          <div
            className={
              isError
                ? "text-sm text-destructive"
                : "text-sm text-muted-foreground"
            }
          >
            {message}
          </div>
          {actions.length > 0 ? (
            <div className="flex justify-center gap-2">
              {actions.map((action) => (
                <Button
                  key={action.id}
                  variant="outline"
                  size="sm"
                  className={
                    isError
                      ? "h-6 border-destructive/30 text-[11px] text-destructive hover:bg-destructive/10"
                      : "h-6 text-[11px]"
                  }
                  onClick={action.onClick}
                  disabled={action.disabled}
                >
                  {action.label}
                </Button>
              ))}
            </div>
          ) : null}
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

            <CheckpointActions
              disabled={
                index === 0 ||
                checkpoint.hash === "pending" ||
                isReverting ||
                activeRevertId === checkpoint.id
              }
              isReverting={isReverting && activeRevertId === checkpoint.id}
              onRevert={() => onRevert(checkpoint)}
              t={t}
            />
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}

interface CheckpointActionsProps {
  disabled?: boolean;
  t: MutableT;
  onRevert: () => void;
  isReverting: boolean;
}

function CheckpointActions({
  disabled = false,
  t,
  onRevert,
  isReverting,
}: CheckpointActionsProps) {
  return (
    <div className="flex items-center gap-0.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-muted-foreground [&_svg]:size-3.5"
            aria-label={t("restoreCheckpoint", "Restore commit")}
            disabled={disabled || isReverting}
            onClick={onRevert}
          >
            <Undo2 className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="left" className="px-2 py-1 text-[11px]">
          {t("restoreCheckpoint", "Restore commit")}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
