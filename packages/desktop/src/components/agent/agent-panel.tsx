import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useLiveQuery, eq } from "@tanstack/react-db";
import {
  ArrowRightLeft,
  ArrowUp,
  Brain,
  Check,
  ChevronRight,
  Eye,
  Globe,
  Loader2,
  Mic,
  Pencil,
  Plus,
  Search,
  Sparkles,
  Square,
  SquareTerminal,
  Telescope,
  Trash2,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import type {
  AuthMethod,
  HarnessDefinition,
  ToolCallContent,
  ToolCallStatus,
  ToolCallUpdate,
  ToolKind,
  PlanEntry,
} from "@metrists/shared/agent";
import { BUILT_IN_HARNESSES } from "@metrists/shared/agent";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useKv } from "@/utils/kv-store";
import { normalizePath } from "@/utils/fs";
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
  startAgentTask,
} from "@/agent/agent-service";
import { PermissionCard } from "./permission-card";
import { jumpToBlob } from "@/components/editor/blobs/jump-to-blob";

/**
 * The agent panel: a task list (create/switch/cancel — parallel tasks are
 * first-class, created on a chosen harness via the picker), and per selected
 * task a prompt input, streamed turn output (message chunks coalesced per
 * turn), inline tool-call cards, that task's permission queue, and its
 * auth-block card when sign-in is required. Reads the task-keyed collections
 * via useLiveQuery and talks to the workspace's TaskManager. This is where
 * tasks are *watched*; the floating prompt (⌘I) is where they're started
 * and steered.
 */
export type AgentPanelProps = {
  workspacePath: string;
};

export function AgentPanel({ workspacePath }: AgentPanelProps) {
  const normalized = normalizePath(workspacePath);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [trustPromptOpen, setTrustPromptOpen] = useState(false);
  // The harness the pending trust confirmation would start (picker choice).
  const [pendingHarness, setPendingHarness] = useState<HarnessDefinition>(
    BUILT_IN_HARNESSES[0],
  );
  const kv = useKv<boolean>("agent");
  const trustKey = `trust:${normalized}`;

  const { data: tasks = [] } = useLiveQuery(
    (q) =>
      q
        .from({ task: agentTasksCollection })
        .where(({ task }) => eq(task.workspacePath, normalized)),
    [normalized],
  );
  // Newest-first (task ids sort descending by construction).
  const sortedTasks = useMemo(
    () => [...tasks].sort((a, b) => (a.taskId < b.taskId ? -1 : 1)),
    [tasks],
  );

  // Default the selection to the newest task.
  useEffect(() => {
    if (!activeTaskId && sortedTasks.length > 0) {
      setActiveTaskId(sortedTasks[0].taskId);
    }
  }, [activeTaskId, sortedTasks]);

  const startTask = useCallback(
    async (harness: HarnessDefinition) => {
      try {
        const taskId = await startAgentTask(workspacePath, harness);
        setActiveTaskId(taskId);
      } catch (error) {
        console.error("Failed to start agent task:", error);
      }
    },
    [workspacePath],
  );

  const handleCreate = useCallback(
    (harness: HarnessDefinition) => {
      if (kv.get(trustKey)) {
        void startTask(harness);
      } else {
        setPendingHarness(harness);
        setTrustPromptOpen(true);
      }
    },
    [kv, trustKey, startTask],
  );

  const confirmTrust = useCallback(() => {
    kv.set(trustKey, true);
    setTrustPromptOpen(false);
    void startTask(pendingHarness);
  }, [kv, trustKey, startTask, pendingHarness]);

  const activeTaskRow = sortedTasks.find((t) => t.taskId === activeTaskId);
  const isRunning = activeTaskRow?.status === "running";

  const sendPrompt = useCallback(() => {
    const text = draft.trim();
    if (!activeTaskId || !text) return;
    promptAgentTask(activeTaskId, text);
    setDraft("");
  }, [draft, activeTaskId]);

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

  const stopTask = useCallback(() => {
    if (!activeTaskId) return;
    void cancelAgentTask(activeTaskId);
  }, [activeTaskId]);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden border-s border-border bg-background">
      <TaskList
        tasks={sortedTasks}
        activeTaskId={activeTaskId}
        onSelect={setActiveTaskId}
        onCreate={handleCreate}
      />

      {activeTaskId ? (
        <div className="relative flex min-h-0 flex-1 flex-col">
          {/* Keyed per task so scroll state never leaks across task switches
              and each task reopens at its own last turn. */}
          <Transcript
            key={activeTaskId}
            taskId={activeTaskId}
            bottomInset={composerHeight}
          />

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
                <MarkerContent className="shimmer">Working…</MarkerContent>
              </Marker>
            )}
            <div className="pointer-events-auto empty:hidden">
              <PermissionCard taskId={activeTaskId} />
            </div>
            {activeTaskRow?.authRequired && (
              <AuthCard task={activeTaskRow} />
            )}
            <PromptBox
              value={draft}
              onChange={setDraft}
              onSend={sendPrompt}
              onStop={stopTask}
              isRunning={isRunning}
            />
          </div>
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center p-4 text-center text-sm text-muted-foreground">
          Start a task to chat with an agent about your documents.
        </div>
      )}

      <AlertDialog open={trustPromptOpen} onOpenChange={setTrustPromptOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Run an agent in this workspace?</AlertDialogTitle>
            <AlertDialogDescription>
              This spawns {pendingHarness.label} as a local process with
              access to the files in this folder. Only continue for workspaces
              you trust.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmTrust}>
              Trust &amp; start
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function TaskList({
  tasks,
  activeTaskId,
  onSelect,
  onCreate,
}: {
  tasks: AgentTaskRow[];
  activeTaskId: string | null;
  onSelect: (taskId: string) => void;
  onCreate: (harness: HarnessDefinition) => void;
}) {
  // Signed-in marks are per harness per machine, written by the service on
  // the first turn that reaches the model (there is no ahead-of-time probe).
  const kv = useKv<boolean>("agent");
  return (
    <div className="flex items-center gap-2 overflow-x-auto border-b border-border p-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline">
            + New task
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {BUILT_IN_HARNESSES.map((harness) => (
            <DropdownMenuItem key={harness.id} onSelect={() => onCreate(harness)}>
              <span className="flex-1">{harness.label}</span>
              {kv.get(`auth:${harness.id}`) && (
                <Check className="size-3.5 text-green-600 dark:text-green-400" />
              )}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {tasks.map((task) => (
        <button
          key={task.taskId}
          onClick={() => onSelect(task.taskId)}
          className={`flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1 text-xs ${
            task.taskId === activeTaskId
              ? "bg-accent text-accent-foreground"
              : "hover:bg-muted"
          }`}
          title={task.title}
        >
          <StatusDot status={task.status} />
          <span className="max-w-[140px] truncate">{task.title}</span>
        </button>
      ))}
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
      <span className="font-medium">Sign-in required</span>
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
          I&apos;ve signed in — retry
        </Button>
      </div>
    </div>
  );
}

function StatusDot({ status }: { status: AgentTaskRow["status"] }) {
  const color =
    status === "running"
      ? "bg-blue-500 animate-pulse"
      : status === "error"
        ? "bg-red-500"
        : status === "idle"
          ? "bg-green-500"
          : status === "cancelled"
            ? "bg-muted-foreground"
            : "bg-amber-500";
  return <span className={`h-2 w-2 shrink-0 rounded-full ${color}`} />;
}


function Transcript({
  taskId,
  bottomInset,
}: {
  taskId: string;
  /** Live height of the floating composer overlay (0 until measured). */
  bottomInset: number;
}) {
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
                  <span className="font-medium">Turn failed:</span> {turn.error}
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
              queued
            </span>
            <button
              type="button"
              title="Remove from queue"
              aria-label="Remove from queue"
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
  if (!text) return null;
  return (
    <details className="w-full max-w-[85%] rounded-lg border border-border/60 bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground">
      <summary className="cursor-pointer select-none">Thinking…</summary>
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
        authored a {rawInput.type} in{" "}
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
        Terminal {item.terminalId}
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
    <span className="text-[11px] text-muted-foreground">{block.type} content</span>
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
 * alongside (⌘⏎ sends). The left affordances mirror the target design; they
 * are visual placeholders until wired to real actions.
 */
function PromptBox({
  value,
  onChange,
  onSend,
  onStop,
  isRunning,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  isRunning: boolean;
}) {
  const canSend = value.trim().length > 0;
  return (
    <div className="pointer-events-auto rounded-2xl border border-border bg-card shadow-lg shadow-black/5 dark:shadow-black/40">
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            onSend();
          }
        }}
        placeholder="Ask anything, @models, /prompts …"
        rows={2}
        className="max-h-40 min-h-[44px] w-full resize-none bg-transparent px-4 pt-3 text-sm placeholder:text-muted-foreground focus-visible:outline-none"
      />
      <div className="flex items-center gap-1 px-2 pb-2">
        <ComposerIconButton label="Add context">
          <Plus />
        </ComposerIconButton>
        <div className="mx-1 h-5 w-px bg-border" />
        <ComposerIconButton label="Prompts">
          <Sparkles />
        </ComposerIconButton>
        <ComposerIconButton label="Explore">
          <Telescope />
        </ComposerIconButton>
        <ComposerIconButton label="Web search">
          <Globe />
        </ComposerIconButton>

        <div className="ms-auto flex items-center gap-1">
          <ComposerIconButton label="Dictate">
            <Mic />
          </ComposerIconButton>
          {isRunning && (
            <Button
              size="icon"
              variant="outline"
              onClick={onStop}
              className="size-9 rounded-xl"
              title="Stop"
              aria-label="Stop"
            >
              <Square className="fill-current" />
            </Button>
          )}
          <Button
            size="icon"
            onClick={onSend}
            disabled={!canSend}
            className="size-9 rounded-xl"
            title={isRunning ? "Queue (⌘⏎)" : "Send (⌘⏎)"}
            aria-label="Send"
          >
            <ArrowUp />
          </Button>
        </div>
      </div>
    </div>
  );
}

function ComposerIconButton({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      title={label}
      aria-label={label}
      className={cn("size-8 rounded-lg text-muted-foreground")}
    >
      {children}
    </Button>
  );
}
