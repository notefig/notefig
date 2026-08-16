/**
 * The sidebar "Git" panel, repurposed for the INTERNAL history repo
 * (`<ws>/.metrists/.git`): a timeline of checkpoints written per agent turn
 * (plus manual saves), which the user can jump back and forth between.
 * Jumping never rewrites history — a safety checkpoint is taken first, so
 * "forward" is just another jump target.
 *
 * The real-git panel this replaced lives on in entities/git.ts (intact but
 * unmounted) for when user-facing git ops return.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import {
  Bot,
  ChevronDown,
  GitCommitHorizontal,
  History,
  User,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useMutation } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { copyTextToClipboard } from "@/utils/clipboard";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  jumpToCheckpoint,
  refetchHistory,
  saveManualCheckpoint,
  useHistoryCheckpoints,
  useHistoryFetching,
  useHistorySummary,
  type HistorySummary,
  type SerializedHistoryError,
  type HistoryCheckpointRow,
} from "@/entities/history";
import type { CheckpointRole } from "@/utils/history-trailers";

interface CheckpointPanelProps {
  workspacePath: string;
}

interface CheckpointListItem {
  id: string;
  oid: string;
  hash: string;
  subject: string;
  role: CheckpointRole;
  timestamp: Date;
}

interface RecoveryAction {
  id: "retry" | "dismiss";
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

type PanelState = "error" | "empty" | "ready";

type MutableT = (key: string, defaultValue: string) => string;

function getErrorPresentation(
  error: SerializedHistoryError,
  t: MutableT,
): { title: string; message: string } {
  switch (error.code) {
    case "LockUnavailable":
      return {
        title: t("timelineBusyTitle", "Checkpoint history is busy"),
        message: t("timelineBusyMessage", "Checkpoint history is busy."),
      };
    case "CorruptRepository":
      return {
        title: t("timelineCorruptTitle", "Checkpoint history needs repair"),
        message: t(
          "timelineCorruptMessage",
          "Checkpoint history metadata is inconsistent.",
        ),
      };
    case "InvalidInput":
      return {
        title: t("timelineInvalidInputTitle", "Invalid input"),
        message: error.message,
      };
    default:
      return {
        title: t("timelineUnexpectedTitle", "Checkpoint history error"),
        message: error.message,
      };
  }
}

function derivePanelState({
  summary,
  checkpoints,
}: {
  summary: HistorySummary | undefined;
  checkpoints: CheckpointListItem[];
}): PanelState {
  if (summary?.error) return "error";
  return checkpoints.length === 0 ? "empty" : "ready";
}

/**
 * Hold the rendered panel state steady while a background fetch is in
 * flight, so transient loading states don't flicker the panel.
 */
function useStablePanelState(
  panelState: PanelState,
  isBackgroundFetching: boolean,
): PanelState {
  const [stablePanelState, setStablePanelState] = useState<PanelState | null>(
    null,
  );

  useEffect(() => {
    if (stablePanelState === null || !isBackgroundFetching) {
      setStablePanelState(panelState);
    }
  }, [panelState, isBackgroundFetching, stablePanelState]);

  return stablePanelState ?? panelState;
}

/**
 * The checkpoint rows shaped for the list, with an in-flight save shown as
 * a pending entry. Purely render-level — an optimistic collection row with
 * a key sync never confirms would strand a ghost in the live query (see
 * entities/git.ts).
 */
function useCheckpointItems(
  checkpointRows: HistoryCheckpointRow[],
  save: { isPending: boolean; variables?: string },
): CheckpointListItem[] {
  return useMemo(() => {
    const items: CheckpointListItem[] = checkpointRows.map((row) => ({
      id: row.oid,
      oid: row.oid,
      hash: row.hash,
      subject: row.subject,
      role: row.role,
      timestamp: new Date(row.timestamp),
    }));
    if (save.isPending) {
      items.unshift({
        id: "pending-save",
        oid: "pending",
        hash: "pending",
        subject: save.variables?.trim() || "Manual checkpoint",
        role: "user",
        timestamp: new Date(),
      });
    }
    return items;
  }, [checkpointRows, save.isPending, save.variables]);
}

/** The jump mutation plus its banner state, as one unit. */
function useJumpController(workspacePath: string) {
  const [jumpError, setJumpError] = useState<SerializedHistoryError | null>(
    null,
  );
  const [activeJumpId, setActiveJumpId] = useState<string | null>(null);

  const jump = useMutation<void, SerializedHistoryError, CheckpointListItem>({
    mutationFn: (checkpoint) =>
      jumpToCheckpoint(workspacePath, {
        oid: checkpoint.oid,
        hash: checkpoint.hash,
        subject: checkpoint.subject,
      }),
    onMutate: (checkpoint) => {
      setJumpError(null);
      setActiveJumpId(checkpoint.id);
    },
    onError: (error) => {
      setJumpError(error);
    },
    onSettled: () => {
      setActiveJumpId(null);
    },
  });

  const dismissJumpError = useCallback(() => setJumpError(null), []);

  return { jump, jumpError, dismissJumpError, activeJumpId };
}

export function CheckpointPanel({ workspacePath }: CheckpointPanelProps) {
  const { t } = useTranslation();
  const [description, setDescription] = useState("");

  const summary = useHistorySummary(workspacePath);
  const checkpointRows = useHistoryCheckpoints(workspacePath);
  const isBackgroundFetching = useHistoryFetching(workspacePath);

  const saveCheckpoint = useMutation<
    string | null,
    SerializedHistoryError,
    string | undefined
  >({
    mutationFn: (value) => saveManualCheckpoint(workspacePath, value),
  });

  const checkpoints = useCheckpointItems(checkpointRows, saveCheckpoint);
  const { jump, jumpError, dismissJumpError, activeJumpId } =
    useJumpController(workspacePath);

  const panelState = derivePanelState({ summary, checkpoints });
  const renderPanelState = useStablePanelState(
    panelState,
    isBackgroundFetching,
  );

  const panelError =
    renderPanelState === "error" ? (summary?.error ?? null) : null;

  return (
    <div className="flex h-full flex-col">
      <SaveCheckpointBar
        isSaving={saveCheckpoint.isPending}
        description={description}
        onDescriptionChange={setDescription}
        onSave={(value) => saveCheckpoint.mutate(value)}
        t={t}
      />

      {jumpError ? (
        <RecoveryBanner
          error={jumpError}
          actions={[
            {
              id: "dismiss",
              label: t("dismiss", "Dismiss"),
              onClick: dismissJumpError,
            },
          ]}
          t={t}
        />
      ) : null}

      <CheckpointsList
        panelState={renderPanelState}
        checkpoints={checkpoints}
        isJumping={jump.isPending}
        activeJumpId={activeJumpId}
        onJump={(checkpoint: CheckpointListItem) => jump.mutate(checkpoint)}
        actions={
          renderPanelState === "error"
            ? [
                {
                  id: "retry",
                  label: t("retry", "Retry"),
                  onClick: () => void refetchHistory(workspacePath),
                },
              ]
            : []
        }
        message={
          renderPanelState === "empty"
            ? t(
                "noHistoryCheckpointsYet",
                "No checkpoints yet. They appear as you work with the agent.",
              )
            : panelError
              ? getErrorPresentation(panelError, t).message
              : null
        }
        isError={renderPanelState === "error"}
        t={t}
      />
    </div>
  );
}

interface RecoveryBannerProps {
  error: SerializedHistoryError;
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
            className="h-6 border-destructive/30 text-[0.6875rem] text-destructive hover:bg-destructive/10"
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

interface SaveCheckpointBarProps {
  isSaving?: boolean;
  description: string;
  onDescriptionChange: (value: string) => void;
  onSave: (description?: string) => void;
  t: MutableT;
}

function SaveCheckpointBar({
  isSaving = false,
  description,
  onDescriptionChange,
  onSave,
  t,
}: SaveCheckpointBarProps) {
  const [open, setOpen] = useState(false);

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
          disabled={isSaving}
          onClick={saveQuick}
          aria-label={t("saveHistoryCheckpoint", "Save checkpoint")}
        >
          <GitCommitHorizontal className="h-3.5 w-3.5" />
          <span className="truncate">
            {isSaving
              ? t("historyCheckpointSaving", "Saving checkpoint...")
              : t("saveHistoryCheckpoint", "Save checkpoint")}
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
            <TooltipContent
              side="bottom"
              className="px-2 py-1 text-[0.6875rem]"
            >
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
                  className="min-h-[5.25rem] resize-none text-sm"
                />
                <div className="flex justify-end">
                  <Button
                    type="button"
                    size="sm"
                    className="h-8 shrink-0 text-xs"
                    onClick={saveWithDescription}
                    disabled={isSaving}
                  >
                    {t("saveHistoryCheckpoint", "Save checkpoint")}
                  </Button>
                </div>
              </div>
            </div>
          </PopoverContent>
        </Popover>
      </ButtonGroup>
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
  onJump: (checkpoint: CheckpointListItem) => void;
  isJumping: boolean;
  activeJumpId: string | null;
}

function CheckpointsList({
  panelState,
  checkpoints,
  actions,
  message,
  isError,
  t,
  onJump,
  isJumping,
  activeJumpId,
}: CheckpointsListProps) {
  if (panelState === "empty" || isError) {
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
                      ? "h-6 border-destructive/30 text-[0.6875rem] text-destructive hover:bg-destructive/10"
                      : "h-6 text-[0.6875rem]"
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
                <RoleBadge role={checkpoint.role} t={t} />
                {checkpoint.subject ? (
                  <span className="truncate text-[0.6875rem] font-medium">
                    {checkpoint.subject}
                  </span>
                ) : (
                  <time
                    className="truncate text-[0.6875rem] text-muted-foreground"
                    dateTime={checkpoint.timestamp.toISOString()}
                  >
                    {formatDistanceToNow(checkpoint.timestamp, {
                      addSuffix: true,
                    })}
                  </time>
                )}
                {index === 0 ? (
                  <span className="inline-flex h-4 max-w-16 shrink-0 items-center truncate whitespace-nowrap rounded-md bg-secondary px-1.5 text-[0.625rem] text-secondary-foreground">
                    {t("latest", "Latest")}
                  </span>
                ) : null}
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 text-[0.625rem] text-muted-foreground">
                <button
                  type="button"
                  className="h-auto w-auto p-0 font-mono leading-none hover:text-foreground"
                  onClick={() => void copyTextToClipboard(checkpoint.hash)}
                  aria-label={t("copyCheckpointHash", "Copy checkpoint hash")}
                >
                  {checkpoint.hash}
                </button>
                <time dateTime={checkpoint.timestamp.toISOString()}>
                  {formatDistanceToNow(checkpoint.timestamp, {
                    addSuffix: true,
                  })}
                </time>
              </div>
            </div>

            <CheckpointActions
              disabled={
                checkpoint.hash === "pending" ||
                isJumping ||
                activeJumpId === checkpoint.id
              }
              isJumping={isJumping && activeJumpId === checkpoint.id}
              onJump={() => onJump(checkpoint)}
              t={t}
            />
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}

function RoleBadge({ role, t }: { role: CheckpointRole; t: MutableT }) {
  const isUser = role === "user";
  const Icon = isUser ? User : Bot;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-md bg-secondary text-secondary-foreground"
          aria-label={
            isUser
              ? t("checkpointByYou", "Saved by you")
              : t("checkpointByAgent", "Saved by the agent")
          }
        >
          <Icon className="h-3 w-3" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" className="px-2 py-1 text-[0.6875rem]">
        {isUser
          ? t("checkpointByYou", "Saved by you")
          : t("checkpointByAgent", "Saved by the agent")}
      </TooltipContent>
    </Tooltip>
  );
}

interface CheckpointActionsProps {
  disabled?: boolean;
  t: MutableT;
  onJump: () => void;
  isJumping: boolean;
}

function CheckpointActions({
  disabled = false,
  t,
  onJump,
  isJumping,
}: CheckpointActionsProps) {
  return (
    <div className="flex items-center gap-0.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-muted-foreground [&_svg]:size-3.5"
            aria-label={t("jumpToCheckpoint", "Jump to this checkpoint")}
            disabled={disabled || isJumping}
            onClick={onJump}
          >
            <History className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="left" className="px-2 py-1 text-[0.6875rem]">
          {t("jumpToCheckpoint", "Jump to this checkpoint")}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
