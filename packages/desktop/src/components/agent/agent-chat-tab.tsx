import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useLiveQuery, eq } from "@tanstack/react-db";
import { useTranslation } from "react-i18next";
import {
  ArrowRightLeft,
  ArrowUp,
  Brain,
  Check,
  ChevronRight,
  Eye,
  Globe,
  Loader2,
  Pencil,
  Search,
  Sparkles,
  Square,
  SquareTerminal,
  Trash2,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import type {
  AuthMethod,
  ToolCallContent,
  ToolCallStatus,
  ToolCallUpdate,
  ToolKind,
  PlanEntry,
} from "@metrists/shared/agent";
import { BUILT_IN_HARNESSES } from "@metrists/shared/agent";
import { Button } from "@/components/ui/button";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import { cn } from "@/lib/utils";
import {
  agentEntriesCollection,
  agentTasksCollection,
  agentTurnsCollection,
  type AgentEntry,
  type AgentTaskRow,
} from "@/agent/agent-collections";
import {
  authenticateAgentTask,
  cancelAgentTask,
  promptAgentTask,
  removeQueuedPrompt,
  retryAgentTaskAfterAuth,
} from "@/agent/agent-service";
import { PermissionCard } from "./permission-card";
import { HarnessLogo } from "./harness-logo";
import {
  clearComposerDraft,
  getComposerDraft,
  setComposerDraft,
} from "./composer-draft-store";
import { jumpToBlob } from "@/components/editor/blobs/jump-to-blob";

/**
 * One agent session as a dockable tab: streamed turn output (message chunks
 * coalesced per turn), inline tool-call cards, the session's permission
 * queue, its auth-block card when sign-in is required, and the floating
 * composer. Pinned to a single taskId — sessions are listed and opened from
 * the sidebar SessionsPanel, and the floating prompt (⌘I) is where tasks are
 * started and steered without opening a tab. The dock mounts only the
 * selected tab, so everything here must survive unmount: the transcript
 * lives in the task-keyed collections and the composer draft in
 * composer-draft-store.
 */
export function AgentChatTab({ taskId }: { taskId: string }) {
  const { t } = useTranslation();
  const [draft, setDraftState] = useState(() => getComposerDraft(taskId));
  const setDraft = useCallback(
    (value: string) => {
      setDraftState(value);
      setComposerDraft(taskId, value);
    },
    [taskId],
  );

  const { data: taskRows = [] } = useLiveQuery(
    (q) =>
      q
        .from({ task: agentTasksCollection })
        .where(({ task }) => eq(task.taskId, taskId)),
    [taskId],
  );
  const taskRow = taskRows[0];
  const isRunning = taskRow?.status === "running";

  const sendPrompt = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    promptAgentTask(taskId, text);
    setDraftState("");
    clearComposerDraft(taskId);
  }, [draft, taskId]);

  const stopTask = useCallback(() => {
    void cancelAgentTask(taskId);
  }, [taskId]);

  // The floating composer overlay's live height (it grows when permission/
  // auth cards stack above the prompt box); the transcript pads its scroll
  // end by this much so no entry ever sits underneath the overlay.
  const [composerEl, setComposerEl] = useState<HTMLDivElement | null>(null);
  const [composerHeight, setComposerHeight] = useState(0);
  useEffect(() => {
    if (!composerEl) return;
    const observer = new ResizeObserver(() =>
      setComposerHeight(composerEl.offsetHeight),
    );
    observer.observe(composerEl);
    setComposerHeight(composerEl.offsetHeight);
    return () => observer.disconnect();
  }, [composerEl]);

  // The tab can outlive the task row for a frame (workspace teardown clears
  // rows before the layout prunes the tab).
  if (!taskRow) {
    return (
      <div className="flex h-full w-full flex-1 items-center justify-center bg-background text-sm text-muted-foreground">
        {t("agentSessionEnded")}
      </div>
    );
  }

  return (
    // The dock's content wrapper is a plain flex box, so this root brings
    // its own positioning context for the absolute composer overlay.
    <div className="relative flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <Transcript taskId={taskId} bottomInset={composerHeight} />

      {/* Floating composer pinned to the bottom of the tab. The gradient
          fades the transcript out behind it; the wrapper is click-through
          (pointer-events-none) so only the cards inside catch pointers.
          Measured so the transcript can pad past it — the overlay grows
          when permission/auth cards stack above the prompt box. */}
      <div
        ref={setComposerEl}
        className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col gap-2 bg-gradient-to-t from-background via-background/95 to-transparent px-3 pb-3 pt-10"
      >
        {isRunning && (
          <Marker
            role="status"
            className="pointer-events-auto self-start rounded-full border border-border bg-card/80 px-3 py-1 backdrop-blur"
          >
            <MarkerIcon>
              <Loader2 className="animate-spin" />
            </MarkerIcon>
            <MarkerContent className="shimmer">{t("agentWorking")}</MarkerContent>
          </Marker>
        )}
        <div className="pointer-events-auto empty:hidden">
          <PermissionCard taskId={taskId} />
        </div>
        {taskRow.authRequired && <AuthCard task={taskRow} />}
        <PromptBox
          value={draft}
          onChange={setDraft}
          onSend={sendPrompt}
          onStop={stopTask}
          isRunning={isRunning}
          harnessId={taskRow.harnessId}
        />
      </div>
    </div>
  );
}

/**
 * Auth-blocked task: sign-in methods off the task row (Stage 4 — auth is
 * task-row state). Each method button tries in-band ACP `authenticate`; the
 * out-of-band terminal logins both current adapters use reject it, and the
 * card then shows the method's description as instructions. "I've signed in"
 * retries the held prompt optimistically — a failed retry re-raises the
 * block.
 */
function AuthCard({ task }: { task: AgentTaskRow }) {
  const { t } = useTranslation();
  const [instructions, setInstructions] = useState<string | null>(null);
  const [busyMethodId, setBusyMethodId] = useState<string | null>(null);
  const methods = task.authMethods ?? [];

  const tryMethod = useCallback(
    async (method: AuthMethod) => {
      setBusyMethodId(method.id);
      setInstructions(null);
      const result = await authenticateAgentTask(task.taskId, method.id);
      setBusyMethodId(null);
      if (!result.ok) {
        // Out-of-band method: show how to sign in instead.
        setInstructions(method.description ?? task.authHint ?? null);
      }
    },
    [task.taskId, task.authHint],
  );

  return (
    // The amber tint rides a gradient *image* over an opaque bg-background:
    // this card floats in the composer overlay above the transcript, so a
    // plain translucent bg would let entries underneath show through it.
    <div className="pointer-events-auto flex flex-col gap-2 rounded-md border border-amber-500/40 bg-background bg-gradient-to-b from-amber-500/10 to-amber-500/10 p-3 text-xs">
      <span className="font-medium">{t("agentSignInRequired")}</span>
      {instructions ? (
        <p className="whitespace-pre-wrap">{instructions}</p>
      ) : (
        task.authHint && <p className="whitespace-pre-wrap">{task.authHint}</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {methods.map((method) => (
          <Button
            key={method.id}
            size="sm"
            variant="outline"
            disabled={busyMethodId !== null}
            onClick={() => void tryMethod(method)}
          >
            {busyMethodId === method.id && (
              <Loader2 className="size-3.5 animate-spin" />
            )}
            {method.name ?? method.id}
          </Button>
        ))}
        <Button
          size="sm"
          onClick={() => retryAgentTaskAfterAuth(task.taskId)}
        >
          {t("agentSignedInRetry")}
        </Button>
      </div>
    </div>
  );
}

function Transcript({
  taskId,
  bottomInset,
}: {
  taskId: string;
  /** Live height of the floating composer overlay (0 until measured). */
  bottomInset: number;
}) {
  const { t } = useTranslation();
  const { data: entries = [] } = useLiveQuery(
    (q) =>
      q
        .from({ entry: agentEntriesCollection })
        .where(({ entry }) => eq(entry.taskId, taskId)),
    [taskId],
  );
  const { data: turns = [] } = useLiveQuery(
    (q) =>
      q
        .from({ turn: agentTurnsCollection })
        .where(({ turn }) => eq(turn.taskId, taskId)),
    [taskId],
  );
  const turnErrors = useMemo(
    () => turns.filter((t) => t.status === "error" && t.error),
    [turns],
  );
  const queuedTurnIds = useMemo(
    () => new Set(turns.filter((t) => t.status === "queued").map((t) => t.turnId)),
    [turns],
  );

  // Ids are ascending, so document order = chronological (text and tool calls
  // interleaved exactly as they streamed).
  const sortedEntries = useMemo(
    () => [...entries].sort((a, b) => (a.id < b.id ? -1 : 1)),
    [entries],
  );

  return (
    // MessageScroller owns all scroll behavior: user prompts are anchors (a
    // new turn lands near the top with a peek of the previous one), streamed
    // replies are followed only while the reader is at the live edge, and a
    // reopened task lands on its last turn instead of the absolute bottom.
    <MessageScrollerProvider
      autoScroll
      defaultScrollPosition="last-anchor"
      scrollPreviousItemPeek={48}
    >
      <MessageScroller className="flex-1 min-h-0">
        <MessageScrollerViewport>
          {/* Bottom padding clears the floating composer overlay: its
              measured height (pb-36 as the pre-measurement fallback), plus
              one gap. */}
          <MessageScrollerContent
            className="gap-3 p-3"
            style={{ paddingBottom: Math.max(bottomInset, 144) + 12 }}
          >
            {sortedEntries.map((entry) => (
              <MessageScrollerItem
                key={entry.id}
                messageId={entry.id}
                scrollAnchor={entry.type === "user"}
              >
                <EntryView
                  entry={entry}
                  queued={entry.type === "user" && queuedTurnIds.has(entry.turnId)}
                />
              </MessageScrollerItem>
            ))}
            {turnErrors.map((turn) => (
              <MessageScrollerItem key={turn.turnId} messageId={`error-${turn.turnId}`}>
                <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400">
                  <span className="font-medium">{t("agentTurnFailed")}</span> {turn.error}
                </div>
              </MessageScrollerItem>
            ))}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        {/* Tucked into the corner just above the composer cards: the overlay
            begins with ~40px of transparent gradient (pt-10), so backing off
            from its measured top keeps the button visually next to the
            prompt box rather than floating high above it. */}
        <MessageScrollerButton
          style={{ bottom: Math.max(bottomInset, 144) - 32 }}
        />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}

/** Render one transcript entry by type; tool calls are peers of text. */
function EntryView({ entry, queued }: { entry: AgentEntry; queued?: boolean }) {
  const { t } = useTranslation();
  if (entry.type === "tool_call") {
    if (!entry.toolCall) return null;
    const CustomCard = TOOL_NAME_RENDERER[entry.toolCall.title ?? ""];
    return CustomCard ? (
      <CustomCard toolCall={entry.toolCall} />
    ) : (
      <ToolCallCard toolCall={entry.toolCall} />
    );
  }
  if (entry.type === "plan") return <PlanView plan={entry.plan} />;
  if (entry.type === "thought") return <ThoughtEntry text={entry.text} />;
  if (entry.type === "unknown") return null; // kept as transcript data only (D4)

  const isUser = entry.type === "user";
  // trim(): models emit whitespace-only chunks around tool calls (a "\n\n"
  // run closed by a tool_call renders as an empty bubble otherwise), and
  // leading/trailing newlines would show inside whitespace-pre-wrap bubbles.
  if (!entry.text?.trim()) return null;
  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm",
          isUser
            ? "bg-primary text-primary-foreground"
            : "bg-muted text-foreground",
          queued && "opacity-70",
        )}
      >
        {entry.text.trim()}
        {queued && (
          <span className="mt-1 flex items-center justify-end gap-1.5">
            <span className="rounded-full bg-primary-foreground/20 px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
              {t("agentQueuedBadge")}
            </span>
            <button
              type="button"
              title={t("agentRemoveFromQueue")}
              aria-label={t("agentRemoveFromQueue")}
              className="rounded-full p-0.5 hover:bg-primary-foreground/20"
              onClick={() => removeQueuedPrompt(entry.taskId, entry.turnId)}
            >
              <X className="size-3" />
            </button>
          </span>
        )}
      </div>
    </div>
  );
}

/** Compact checklist for a `plan` session update (ACP entries: content/priority/status). */
function PlanView({ plan }: { plan: unknown }) {
  const entries = (plan as { entries?: PlanEntry[] } | undefined)?.entries ?? [];
  if (entries.length === 0) return null;
  return (
    <div className="w-full max-w-[85%] rounded-lg border border-border bg-card px-2.5 py-2 text-xs">
      {entries.map((planEntry, i) => (
        <div key={i} className="flex items-center gap-2 py-0.5">
          {planEntry.status === "completed" ? (
            <Check className="size-3.5 shrink-0 text-green-600 dark:text-green-400" />
          ) : planEntry.status === "in_progress" ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
          ) : (
            <span className="size-3.5 shrink-0" />
          )}
          <span
            className={cn(
              "flex-1",
              planEntry.status === "completed" && "text-muted-foreground line-through",
            )}
          >
            {planEntry.content}
          </span>
        </div>
      ))}
    </div>
  );
}

/** One coalesced thought run (a contiguous block of agent_thought_chunk
 *  updates streams into a single entry upstream), collapsed by default. */
function ThoughtEntry({ text }: { text?: string }) {
  const { t } = useTranslation();
  if (!text) return null;
  return (
    <details className="w-full max-w-[85%] rounded-lg border border-border/60 bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground">
      <summary className="cursor-pointer select-none">{t("agentThinking")}</summary>
      <p className="mt-1 whitespace-pre-wrap">{text}</p>
    </details>
  );
}

/**
 * Per-tool-name transcript renderers, for tools whose generic ToolCallCard
 * (raw JSON result) isn't a useful summary. Deliberately a plain lookup
 * table, not a glob-based registry like blob-registry.ts — proportionate to
 * the one case that exists today; promote to a real registry file if a
 * second one shows up.
 */
const TOOL_NAME_RENDERER: Record<string, (props: { toolCall: ToolCallUpdate }) => ReactNode> = {
  author_blob: AuthorBlobCard,
};

/** "authored a question in notes.md" instead of the raw {blobId} JSON result. */
function AuthorBlobCard({ toolCall: call }: { toolCall: ToolCallUpdate }) {
  const { t } = useTranslation();
  const rawInput = call.rawInput as { path?: string; type?: string; id?: string } | undefined;
  const status: ToolCallStatus = call.status ?? "pending";
  if (!rawInput?.path || !rawInput.type || !rawInput.id) {
    return <ToolCallCard toolCall={call} />;
  }
  // rawInput.path is whatever the agent sent (usually workspace-relative);
  // locations[0] carries the workspace-resolved absolute path the jump needs.
  const jumpPath = call.locations?.[0]?.path ?? rawInput.path;
  const fileName = rawInput.path.split("/").pop();
  return (
    <div className="flex w-full max-w-[85%] items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs">
      <Sparkles className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="flex-1">
        {t("agentAuthoredBlob", { type: rawInput.type })}{" "}
        <button
          type="button"
          className="underline hover:text-foreground"
          onClick={() => jumpToBlob(jumpPath, rawInput.id!)}
        >
          {fileName}
        </button>
      </span>
      <ToolStatusIcon status={status} />
    </div>
  );
}

const TOOL_KIND_ICON: Record<ToolKind, LucideIcon> = {
  read: Eye,
  edit: Pencil,
  delete: Trash2,
  move: ArrowRightLeft,
  search: Search,
  execute: SquareTerminal,
  think: Brain,
  fetch: Globe,
  switch_mode: Wrench,
  other: Wrench,
};

/**
 * One tool call, coalesced into a single row upstream. Header (kind icon +
 * title + live status) is always shown; the body — file diffs, command/tool
 * output, or the raw input for tools with no content — is collapsible and
 * defaults open while the call is active or failed, collapsed once completed.
 */
function ToolCallCard({ toolCall: call }: { toolCall: ToolCallUpdate }) {
  const kind = call.kind ?? "other";
  const status: ToolCallStatus = call.status ?? "pending";
  const title = call.title ?? kind;
  const content = call.content ?? [];
  const locations = call.locations ?? [];
  const rawInput = call.rawInput;
  const Icon = TOOL_KIND_ICON[kind] ?? Wrench;

  const failed = status === "failed";
  const hasBody =
    content.length > 0 ||
    locations.length > 0 ||
    (content.length === 0 && rawInput != null);

  // null = follow the default (open while active/failed); a boolean is an
  // explicit user toggle that then sticks.
  const [override, setOverride] = useState<boolean | null>(null);
  const defaultOpen = status !== "completed";
  const open = override ?? defaultOpen;

  return (
    <div
      className={cn(
        "w-full max-w-[85%] overflow-hidden rounded-lg border text-xs",
        failed ? "border-destructive/40 bg-destructive/5" : "border-border bg-card",
      )}
    >
      <button
        type="button"
        onClick={() => hasBody && setOverride(!open)}
        className={cn(
          "flex w-full items-center gap-2 px-2.5 py-1.5 text-left",
          hasBody && "cursor-pointer",
        )}
      >
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
        <ToolStatusIcon status={status} />
        {hasBody && (
          <ChevronRight
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
        )}
      </button>

      {hasBody && open && (
        <div className="flex flex-col gap-2 border-t border-border/60 px-2.5 py-2">
          {content.map((item, i) => (
            <ToolContentView key={i} item={item} />
          ))}
          {content.length === 0 && rawInput != null && (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/60 p-2 font-mono text-[11px] text-muted-foreground">
              {rawInputPreview(rawInput)}
            </pre>
          )}
          {locations.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {locations.map((loc, i) => (
                <span
                  key={i}
                  className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
                >
                  {loc.path.split("/").pop()}
                  {loc.line != null ? `:${loc.line}` : ""}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ToolStatusIcon({ status }: { status: ToolCallStatus }) {
  if (status === "completed") {
    return <Check className="size-3.5 shrink-0 text-green-600 dark:text-green-400" />;
  }
  if (status === "failed") {
    return <X className="size-3.5 shrink-0 text-destructive" />;
  }
  // pending / in_progress
  return <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />;
}

function ToolContentView({ item }: { item: ToolCallContent }) {
  const { t } = useTranslation();
  if (item.type === "diff") {
    const added = item.newText ? item.newText.split("\n").length : 0;
    const removed = item.oldText ? item.oldText.split("\n").length : 0;
    return (
      <div className="overflow-hidden rounded border border-border/60">
        <div className="flex items-center gap-2 bg-muted/60 px-2 py-1 font-mono text-[11px]">
          <span className="min-w-0 flex-1 truncate">{item.path}</span>
          <span className="shrink-0 text-green-600 dark:text-green-400">
            +{added}
          </span>
          {item.oldText != null && (
            <span className="shrink-0 text-destructive">−{removed}</span>
          )}
        </div>
        <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all p-2 font-mono text-[11px]">
          {item.newText}
        </pre>
      </div>
    );
  }
  if (item.type === "terminal") {
    return (
      <span className="font-mono text-[11px] text-muted-foreground">
        {t("agentTerminal", { id: item.terminalId })}
      </span>
    );
  }
  // { type: "content", content: ContentBlock }
  const block = item.content;
  if (block.type === "text") {
    return (
      <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/60 p-2 text-[11px]">
        {block.text}
      </pre>
    );
  }
  return (
    <span className="text-[11px] text-muted-foreground">
      {t("agentContentOfType", { type: block.type })}
    </span>
  );
}

/** One-line-ish preview of a tool's raw input; prefer a `command` field. */
function rawInputPreview(rawInput: Record<string, unknown>): string {
  if (typeof rawInput.command === "string") return rawInput.command;
  try {
    return JSON.stringify(rawInput);
  } catch {
    return String(rawInput);
  }
}

/**
 * The floating composer: a rounded card pinned to the bottom of the tab with
 * the prompt input above a toolbar row. Send stays enabled while a turn runs
 * — sending then queues the prompt (FIFO, lossless) — with Stop available
 * alongside (⏎ sends, ⇧⏎ inserts a newline). The left affordances mirror
 * the target design; they are visual placeholders until wired to real
 * actions.
 */
function PromptBox({
  value,
  onChange,
  onSend,
  onStop,
  isRunning,
  harnessId,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  isRunning: boolean;
  harnessId: string;
}) {
  const { t } = useTranslation();
  const canSend = value.trim().length > 0;
  return (
    <div className="pointer-events-auto rounded-2xl border border-border bg-card shadow-lg shadow-black/5 dark:shadow-black/40">
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        // autoFocus: mount == tab selected (the dock unmounts unselected
        // tabs), and pulling focus into the dock is also what keeps the
        // tab hotkeys (Ctrl+Tab, ⌘W, ⌘1-9) alive — they listen on the
        // dockable container, the way editors self-focus on tab-select.
        autoFocus
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            onSend();
          }
        }}
        placeholder={t("agentPromptPlaceholder")}
        rows={2}
        className="max-h-40 min-h-[44px] w-full resize-none bg-transparent px-4 pt-3 text-sm placeholder:text-muted-foreground focus-visible:outline-none"
      />
      <div className="flex items-center gap-1 px-2 pb-2">
        {/* The session is pinned to one harness — a passive indicator, not
            a picker (the sidebar's new-session split button chooses). */}
        <span className="flex items-center gap-1.5 px-1.5 text-[11px] text-muted-foreground">
          <HarnessLogo harnessId={harnessId} className="size-3" />
          {harnessLabel(harnessId)}
        </span>

        <div className="ms-auto flex items-center gap-1">
          {isRunning && (
            <Button
              size="icon"
              variant="outline"
              onClick={onStop}
              className="size-9 rounded-xl"
              title={t("agentStop")}
              aria-label={t("agentStop")}
            >
              <Square className="fill-current" />
            </Button>
          )}
          <Button
            size="icon"
            onClick={onSend}
            disabled={!canSend}
            className="size-9 rounded-xl"
            title={isRunning ? t("agentQueue") : t("agentSend")}
            aria-label={isRunning ? t("agentQueue") : t("agentSend")}
          >
            <ArrowUp />
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Label for a harness id (built-ins today; falls back to the raw id). */
function harnessLabel(harnessId: string): string {
  return (
    BUILT_IN_HARNESSES.find((harness) => harness.id === harnessId)?.label ??
    harnessId
  );
}
