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
import { useMutation, type UseMutateFunction } from "@tanstack/react-query";

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
  abortRevert as abortRevertAction,
  deriveSyncState,
  initializeGit,
  refetchGit,
  revertToCheckpoint,
  saveCheckpoint as saveCheckpointAction,
  useGitCheckpoints,
  useGitFetching,
  useGitSummary,
  type GitSummary,
  type SerializedGitError,
  type SyncState,
} from "@/entities/git";

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

interface PanelErrorState {
  checkpoints: CheckpointListItem[];
  error: SerializedGitError | null;
}

type PanelState = "uninitialized" | "error" | "empty" | "ready";

type MutableT = (key: string, defaultValue: string) => string;

function getErrorPresentation(
  error: SerializedGitError,
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
  summary,
  initializeError,
  checkpoints,
}: {
  summary: GitSummary | undefined;
  initializeError: SerializedGitError | null;
  checkpoints: CheckpointListItem[];
}): PanelState {
  if (summary && !summary.initialized && checkpoints.length === 0) {
    return "uninitialized";
  }

  if (initializeError || summary?.statusError || summary?.logError) {
    return "error";
  }

  if (checkpoints.length === 0) {
    return "empty";
  }

  return "ready";
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
  const [autoSaveEnabled, setAutoSaveEnabled] = useState(false);
  const [description, setDescription] = useState("");
  const [stablePanelState, setStablePanelState] = useState<PanelState | null>(
    null,
  );
  const [revertError, setRevertError] = useState<SerializedGitError | null>(
    null,
  );
  const [activeRevertId, setActiveRevertId] = useState<string | null>(null);

  const summary = useGitSummary(workspacePath);
  const checkpointRows = useGitCheckpoints(workspacePath);

  const saveCheckpoint = useMutation<
    string | null,
    SerializedGitError,
    string | undefined
  >({
    mutationFn: (value) => saveCheckpointAction(workspacePath, value),
  });

  // While the commit is in flight, show it as a pending list entry. Purely
  // render-level — an optimistic collection row with a key sync never
  // confirms would strand a ghost in the live query (see entities/git.ts).
  const checkpoints: CheckpointListItem[] = useMemo(() => {
    const items: CheckpointListItem[] = checkpointRows.map((row) => ({
      id: row.oid || row.id,
      hash: row.hash,
      timestamp: new Date(row.timestamp),
      message: row.message,
    }));
    if (saveCheckpoint.isPending) {
      items.unshift({
        id: "pending-save",
        hash: "pending",
        timestamp: new Date(),
        message: saveCheckpoint.variables?.trim() || "Commit",
      });
    }
    return items;
  }, [checkpointRows, saveCheckpoint.isPending, saveCheckpoint.variables]);

  const initializeTimeline = useMutation<void, SerializedGitError, void>({
    mutationFn: () => initializeGit(workspacePath),
  });

  const initializeError = initializeTimeline.error ?? null;

  const panelState = derivePanelState({
    summary,
    initializeError,
    checkpoints,
  });

  const isBackgroundFetching = useGitFetching(workspacePath);

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

  const state: PanelErrorState = {
    checkpoints,
    error:
      renderPanelState === "error"
        ? (initializeError ??
          summary?.logError ??
          summary?.statusError ??
          null)
        : null,
  };

  const runRetry = () => {
    void refetchGit(workspacePath);
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

  const syncState = deriveSyncState(summary);
  const hasChanges = summary?.hasChanges ?? false;
  const canSave = renderPanelState !== "uninitialized" && hasChanges;

  const revertCommit = useMutation<void, SerializedGitError, CheckpointListItem>({
    mutationFn: (checkpoint) =>
      revertToCheckpoint(workspacePath, {
        oid: checkpoint.id,
        hash: checkpoint.hash,
      }),
    onMutate: (checkpoint) => {
      setRevertError(null);
      setActiveRevertId(checkpoint.id);
    },
    onSuccess: () => {
      setRevertError(null);
    },
    onError: (error) => {
      setRevertError(error);
    },
    onSettled: () => {
      setActiveRevertId(null);
    },
  });

  const abortRevert = useMutation<void, SerializedGitError, void>({
    mutationFn: () => abortRevertAction(workspacePath),
    onSuccess: () => {
      setRevertError(null);
    },
  });

  const revertActions: RecoveryAction[] = useMemo(() => {
    if (!revertError) return [];
    if (revertError.code === "MergeRequired") {
      return [
        {
          id: "abort",
          label: t("abortRevert", "Abort revert"),
          onClick: () => abortRevert.mutate(),
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
  error: SerializedGitError;
  t: MutableT;
  retry: () => void;
  initialize: UseMutateFunction<void, SerializedGitError, void, unknown>;
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
  error: SerializedGitError;
  actions: RecoveryAction[];
  t: MutableT;
}

function RecoveryBanner({ error, actions, t }: RecoveryBannerProps) {
  const content = getErrorPresentation(error, t);

  return (
    <div className="m-0 w-full rounded-none border-0 bg-destructive/10 px-3 py-2">
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
