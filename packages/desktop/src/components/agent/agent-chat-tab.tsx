// Pre-existing tangle: the editor component graph (jump-to-blob →
// editor-store → ai-prompt-node → prompt-blob) reaches back to this tab.
// Untangling means relocating the editor registry to a leaf module (see
// file-sync's editor-store import comment); new cycles elsewhere still gate.
// fallow-ignore-file circular-dependency
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronRight,
  Loader2,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import type {
  AuthMethod,
  ToolCallContent,
  ToolCallStatus,
  ToolCallUpdate,
  PlanEntry,
} from "@notefig/shared/agent";
import { BUILT_IN_HARNESSES } from "@notefig/shared/agent";
import { useActiveHarnesses } from "@/hooks/use-harness-selection";
import { useAutosizeTextarea } from "@/hooks/use-autosize-textarea";
import { Button } from "@/components/ui/button";
import {
  MessageScrollerProvider,
  useMessageScroller,
} from "@/components/ui/message-scroller";
import { Markdown } from "@/components/ui/markdown";
import { cn } from "@/lib/utils";
import {
  useTaskRow,
  useTaskEntries,
  useTaskTurns,
  type AgentEntry,
  type AgentTaskRow,
  type AgentTurn,
} from "@/entities/agents";
import {
  authenticateAgentTask,
  cancelAgentTask,
  cancelAgentTurnAndForget,
  deleteAgentSession,
  promptAgentTask,
  removeQueuedPrompt,
  retryAgentTaskAfterAuth,
  reviveAgentTask,
} from "@/agent/agent-service";
import { PermissionCard } from "./permission-card";
import { HarnessLogo } from "./harness-logo";
import {
  clearComposerDraft,
  getComposerDraft,
  setComposerDraft,
  getLastSentPrompt,
  setLastSentPrompt,
} from "./composer-draft-store";
import {
  deriveComposerButton,
  deriveComposerKeyAction,
} from "./prompt-blob-state";
import { CopyTextButton } from "./copy-text-button";
import { jumpToBlob } from "@/components/editor/blobs/jump-to-blob";

/**
 * One agent session as a dockable tab: streamed turn output (message chunks
 * coalesced per turn), inline tool-call cards, the session's permission
 * queue, its auth-block card when sign-in is required, and the floating
 * composer. Pinned to a single taskId — sessions are listed and opened from
 * the sidebar SessionsPanel, and the inline prompt blob in each markdown
 * editor is where tasks are started without opening a tab. The dock mounts only the
 * selected tab, so everything here must survive unmount: the transcript
 * lives in the task-keyed collections and the composer draft in
 * composer-draft-store.
 */
export function AgentChatTab({ taskId }: { taskId: string }) {
  return (
    // Conventional chat scrolling: pinned to the live edge while the reader
    // is at the bottom, hands-off once they scroll up, and a reopened task
    // lands at the end. The provider wraps the whole tab (not just the
    // transcript) so the composer can jump to the end on send.
    // scrollEdgeThreshold: the primitive's 8px default is too tight for a
    // transcript whose rich content reflows — a sub-threshold residue keeps
    // "at end" false and blocks follow mode from re-arming (MET-104).
    <MessageScrollerProvider
      autoScroll
      defaultScrollPosition="end"
      scrollEdgeThreshold={48}
    >
      <AgentChatTabBody taskId={taskId} />
    </MessageScrollerProvider>
  );
}

function AgentChatTabBody({ taskId }: { taskId: string }) {
  const { t } = useTranslation();
  const taskRow = useTaskRow(taskId);
  const isRunning = taskRow?.status === "running";
  // The session/load window (MET-54): a restored row waiting for its revive,
  // or one whose revival is mid-flight ("starting" + a sessionId — a brand
  // new task spawns as "starting" but has no sessionId yet). History is
  // streaming into the transcript; the composer must not accept input.
  const isLoadingSession =
    taskRow?.status === "restored" ||
    (taskRow?.status === "starting" && taskRow.sessionId != null);

  // A restored session revives transparently when its tab is viewed: the
  // dock mounts only the selected tab, so this fires on open/selection, and
  // session/load streams the history back into the transcript (MET-54).
  const status = taskRow?.status;
  useEffect(() => {
    if (status === "restored") reviveAgentTask(taskId);
  }, [status, taskId]);

  // The floating composer overlay's live height (it grows when permission/
  // auth cards stack above the prompt box); the transcript pads its scroll
  // end by this much so no entry ever sits underneath the overlay.
  const [composerEl, setComposerEl] = useState<HTMLDivElement | null>(null);
  const composerHeight = useMeasuredHeight(composerEl);

  // The transcript is virtualized (windowed) and owns its own scroll
  // container, so it no longer registers with the MessageScrollerProvider
  // above it (see Transcript's doc comment). The composer still needs to
  // jump the view to the live edge on send — this ref is Transcript's own
  // scrollToEnd, handed down as a mutable box rather than context so a
  // send doesn't need to re-render the transcript to reach it.
  const transcriptScrollRef = useRef<TranscriptScrollHandle>({
    scrollToEnd: () => {},
  });

  // The tab can outlive the task row for a frame (workspace teardown clears
  // rows before the layout prunes the tab).
  if (!taskRow) {
    return (
      <div className="flex h-full w-full flex-1 items-center justify-center text-sm text-muted-foreground">
        {t("agentSessionEnded")}
      </div>
    );
  }

  return (
    // The dock's content wrapper is a plain flex box, so this root brings
    // its own positioning context for the absolute composer overlay.
    <div className="relative flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden">
      <Transcript
        taskId={taskId}
        bottomInset={composerHeight}
        scrollHandleRef={transcriptScrollRef}
      />
      <ComposerOverlay
        containerRef={setComposerEl}
        taskRow={taskRow}
        isRunning={isRunning}
        isLoadingSession={isLoadingSession}
        transcriptScrollRef={transcriptScrollRef}
      />
    </div>
  );
}

/** An element's live rendered height, tracked through a ResizeObserver
 *  (0 until the element mounts and is first measured). */
function useMeasuredHeight(element: HTMLElement | null): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    if (!element) return;
    const observer = new ResizeObserver(() => setHeight(element.offsetHeight));
    observer.observe(element);
    setHeight(element.offsetHeight);
    return () => observer.disconnect();
  }, [element]);
  return height;
}

/**
 * Floating composer pinned to the bottom of the tab: working shimmer,
 * permission/auth cards, then the prompt box (or the unavailable notice).
 * The gradient fades the transcript out behind it; the wrapper is
 * click-through (pointer-events-none) so only the cards inside catch
 * pointers. Measured via containerRef so the transcript can pad past it —
 * the overlay grows when permission/auth cards stack above the prompt box.
 *
 * Owns the draft state (MET-139): keystrokes must re-render only this
 * overlay, never AgentChatTabBody and the transcript above it — with the
 * draft lifted there, every keypress reconciled one scroller item per
 * entry. The session is pinned to one taskId for the tab's lifetime, so
 * the useState initializer reading the draft store is safe.
 */
function ComposerOverlay({
  containerRef,
  taskRow,
  isRunning,
  isLoadingSession,
  transcriptScrollRef,
}: {
  containerRef: (el: HTMLDivElement | null) => void;
  taskRow: AgentTaskRow;
  isRunning: boolean;
  isLoadingSession: boolean;
  /** Transcript's own scroll-to-end (it bypasses the provider below — see
   *  Transcript's doc comment). */
  transcriptScrollRef: TranscriptScrollHandleRef;
}) {
  const { t } = useTranslation();
  // The provider's scrollToEnd is a no-op now (nothing registers with it —
  // Transcript owns its own scroll container), kept only so this hook call
  // doesn't need the provider ripped out from around the tab.
  useMessageScroller();
  const taskId = taskRow.taskId;
  const [draft, setDraftState] = useState(() => getComposerDraft(taskId));
  const setDraft = useCallback(
    (value: string) => {
      setDraftState(value);
      setComposerDraft(taskId, value);
    },
    [taskId],
  );

  const sendPrompt = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    promptAgentTask(taskId, text);
    setLastSentPrompt(taskId, text);
    setDraftState("");
    clearComposerDraft(taskId);
    // Jump to the live edge so the sent message is in view even when the
    // reader had scrolled up into history; this also re-enters follow mode
    // for the streamed reply.
    transcriptScrollRef.current.scrollToEnd();
  }, [draft, taskId, transcriptScrollRef]);

  const stopTask = useCallback(() => {
    void cancelAgentTask(taskId);
  }, [taskId]);

  // Escape while a turn runs (MET-94): cancel it and — when the agent
  // hadn't responded yet — drop its round from the transcript and put the
  // sent prompt back into the composer. Once a response exists the round
  // stays (forgetting it would hide context the session still holds) and
  // nothing is restored: the prompt is right there in the round. The
  // restore never clobbers a half-typed follow-up, and reads the draft
  // store at resolve time — the closure's `draft` predates the await.
  const cancelAndRestore = useCallback(() => {
    void cancelAgentTurnAndForget(taskId).then((forgot) => {
      if (!forgot) return;
      if (getComposerDraft(taskId).trim() !== "") return;
      const lastSent = getLastSentPrompt(taskId);
      if (lastSent) setDraft(lastSent);
    });
  }, [taskId, setDraft]);

  return (
    <div
      ref={containerRef}
      className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col gap-2 bg-gradient-to-t from-background via-background/95 to-transparent px-3 pb-3 pt-10"
    >
      {/* Bare shimmer text, no pill/spinner — the transcript is flat,
          and so is its thinking indicator. */}
      {isRunning && (
        <span
          role="status"
          className="shimmer pointer-events-auto self-start px-1 text-xs text-muted-foreground"
        >
          {t("agentWorking")}
        </span>
      )}
      <div className="pointer-events-auto empty:hidden">
        <PermissionCard taskId={taskRow.taskId} />
      </div>
      {taskRow.authRequired && <AuthCard task={taskRow} />}
      {taskRow.status === "unavailable" ? (
        <UnavailableCard taskId={taskRow.taskId} />
      ) : (
        <PromptBox
          value={draft}
          onChange={setDraft}
          onSend={sendPrompt}
          onStop={stopTask}
          onCancelRestore={cancelAndRestore}
          isRunning={isRunning}
          disabled={isLoadingSession}
          harnessId={taskRow.harnessId}
        />
      )}
    </div>
  );
}

/**
 * Revival failed (MET-54): the harness no longer has this session — its
 * transcript can't come back, so the composer gives way to an explanation
 * plus the one action that makes sense: delete the session everywhere.
 */
function UnavailableCard({ taskId }: { taskId: string }) {
  const { t } = useTranslation();
  return (
    <div className="pointer-events-auto flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2 text-sm text-muted-foreground">
      <span className="min-w-0 flex-1">
        {t("agentSessionUnavailableNotice")}
      </span>
      <Button
        variant="outline"
        size="sm"
        className="shrink-0"
        onClick={() => void deleteAgentSession(taskId)}
      >
        {t("agentDeleteSession")}
      </Button>
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
export function AuthCard({
  task,
  bare = false,
}: {
  task: AgentTaskRow;
  /** Skip the card's own border/bg/padding — for hosts (the prompt-blob
   *  widget) that already wrap it in an equivalently-tinted container. */
  bare?: boolean;
}) {
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
    <div
      className={cn(
        "pointer-events-auto flex flex-col gap-2 text-xs",
        // The amber tint rides a gradient *image* over an opaque
        // bg-background: this card floats in the composer overlay above the
        // transcript, so a plain translucent bg would let entries underneath
        // show through it. `bare` hosts (the prompt-blob widget) already
        // wrap this in their own equivalently-tinted card, so they skip it.
        !bare &&
          "rounded-md border border-amber-500/40 bg-background bg-gradient-to-b from-amber-500/10 to-amber-500/10 p-3",
      )}
    >
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
        <Button size="sm" onClick={() => retryAgentTaskAfterAuth(task.taskId)}>
          {t("agentSignedInRetry")}
        </Button>
      </div>
    </div>
  );
}

/** One transcript row fed to the virtualizer — entries and turn-error
 *  banners are peers in the same windowed list, so one bottom-anchor/follow
 *  path covers both. */
type TranscriptRow =
  | { kind: "entry"; entry: AgentEntry; queued: boolean }
  | { kind: "error"; turn: AgentTurn };

function transcriptRowKey(row: TranscriptRow): string {
  return row.kind === "entry" ? row.entry.id : `error-${row.turn.turnId}`;
}

/** Per-type height guess for a row that hasn't been measured yet; a close
 *  estimate keeps the scrollbar honest and minimizes reveal jumps —
 *  `measureElement` corrects these as rows mount. Values are measured
 *  medians (incl. the row's own pb-3) over the mock harness's
 *  representative transcript (MET-149); re-measure if entry styling
 *  changes materially. */
function estimateRowSize(row: TranscriptRow): number {
  if (row.kind === "error") return 44;
  switch (row.entry.type) {
    case "tool_call":
      return 42;
    case "thought":
      return 48;
    case "user":
      return 86;
    case "plan":
      return 164;
    case "assistant":
      return 617;
    default:
      return 1; // "unknown" entries render null (D4)
  }
}

/** Transcript's own scroll-to-end, handed to the composer via a ref (see
 *  AgentChatTabBody) since the transcript no longer registers with the
 *  MessageScrollerProvider above it. Always initialized with a real object
 *  (never null), so the ref type stays non-nullable — a plain mutable box,
 *  not React's RefObject<T | null>. */
type TranscriptScrollHandle = { scrollToEnd: () => void };
type TranscriptScrollHandleRef = { current: TranscriptScrollHandle };

/**
 * Memoized (MET-139): the body re-renders on task-row status flips that
 * don't concern the transcript; its own collection hooks pull in entry
 * changes regardless. Shallow compare suffices — both props are scalars
 * (the ref object itself is stable across the tab's lifetime).
 *
 * Virtualized (MET-149): with 2000+ entries, every streamed chunk
 * reconciled the *whole* flat list, dropping the app to ~2fps. Only the
 * on-screen rows (± overscan) exist in the DOM; @tanstack/react-virtual
 * keeps the scrollbar spanning the full transcript. Bottom-anchoring over
 * variable-height rows rides the library's chat mode (`anchorTo: "end"`),
 * whose measurement compensation keeps both the pinned tail and scrolled-up
 * history from jumping as estimates give way to real sizes.
 *
 * This bypasses the @shadcn message-scroller primitive for the transcript
 * surface: its follow mode walks Content's real DOM children with an
 * IntersectionObserver, which can't work against a windowed
 * (absolutely-positioned, subset) child list. The MessageScrollerProvider
 * above the tab stays mounted only so ComposerOverlay's
 * useMessageScroller() keeps resolving (a no-op here); the composer reaches
 * this transcript's real scrollToEnd via `scrollHandleRef`.
 */
const Transcript = memo(function Transcript({
  taskId,
  bottomInset,
  scrollHandleRef,
}: {
  taskId: string;
  /** Live height of the floating composer overlay (0 until measured). */
  bottomInset: number;
  /** Filled in with this transcript's real scrollToEnd (see doc comment). */
  scrollHandleRef: TranscriptScrollHandleRef;
}) {
  const { t } = useTranslation();
  const entries = useTaskEntries(taskId);
  const turns = useTaskTurns(taskId);
  const turnErrors = useMemo(
    () => turns.filter((t) => t.status === "error" && t.error),
    [turns],
  );
  const queuedTurnIds = useMemo(
    () =>
      new Set(turns.filter((t) => t.status === "queued").map((t) => t.turnId)),
    [turns],
  );

  // Ids are ascending, so document order = chronological (text and tool calls
  // interleaved exactly as they streamed).
  const sortedEntries = useMemo(
    () => [...entries].sort((a, b) => (a.id < b.id ? -1 : 1)),
    [entries],
  );

  const rows = useMemo<TranscriptRow[]>(
    () => [
      ...sortedEntries.map(
        (entry): TranscriptRow => ({
          kind: "entry",
          entry,
          queued: entry.type === "user" && queuedTurnIds.has(entry.turnId),
        }),
      ),
      ...turnErrors.map((turn): TranscriptRow => ({ kind: "error", turn })),
    ],
    [sortedEntries, queuedTurnIds, turnErrors],
  );

  const scrollElRef = useRef<HTMLDivElement | null>(null);
  // Live edge tracking for the floating button; re-render-worthy (unlike
  // the row virtualizer's own internal isAtEnd check) since it drives what
  // paints. Starts true: a freshly opened/reopened tab lands at the end.
  const [pinned, setPinned] = useState(true);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollElRef.current,
    estimateSize: (index) => estimateRowSize(rows[index]),
    getItemKey: (index) => transcriptRowKey(rows[index]),
    overscan: 8,
    // Chat mode (see doc comment): follow the live edge on append while
    // pinned, and compensate scrollTop as the tail's real height replaces
    // its estimate so a pinned view never jumps while streaming.
    anchorTo: "end",
    followOnAppend: "auto",
    scrollEndThreshold: 48,
  });

  // Detach is INTENT-based: the re-glue below and the virtualizer's
  // measurement compensation both move scrollTop programmatically, and
  // mid-adjustment scroll events routinely observe a large distance-from-
  // end — deriving `pinned` from distance alone falsely detached during
  // fast torrents (the old primitive detached on wheel for the same
  // reason, MET-104). Only a user gesture may detach: a wheel tick
  // (consumed by the scroll event it produces) or a held pointer
  // (scrollbar drag / touch pan). Re-arming stays distance-based.
  const wheelIntent = useRef(false);
  const pointerHeld = useRef(false);
  const handleScroll = useCallback(() => {
    const el = scrollElRef.current;
    if (!el) return;
    const distanceFromEnd = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromEnd <= 48) {
      setPinned(true);
    } else if (wheelIntent.current || pointerHeld.current) {
      setPinned(false);
    }
    wheelIntent.current = false;
  }, []);

  // While pinned, `pinned` is the follow-mode authority — re-glue on every
  // append and on bottomInset changes. followOnAppend("auto") alone loses
  // the live edge under fast torrents (session/load replay): bursty
  // appends push the gap past scrollEndThreshold between anchor checks and
  // it silently stops following without any user scroll. The clearance
  // spacer (bottomInset) likewise grows without touching row count, so no
  // append-side mechanism ever sees it.
  useLayoutEffect(() => {
    if (pinned) rowVirtualizer.scrollToEnd({ behavior: "auto" });
  }, [bottomInset, pinned, rows.length, rowVirtualizer]);

  useEffect(() => {
    scrollHandleRef.current.scrollToEnd = () => {
      rowVirtualizer.scrollToEnd({ behavior: "auto" });
      setPinned(true);
    };
  }, [rowVirtualizer, scrollHandleRef]);

  const virtualItems = rowVirtualizer.getVirtualItems();

  return (
    <div className="relative flex-1 min-h-0 flex flex-col overflow-hidden">
      {/* overflow-anchor:none — browser scroll anchoring's spontaneous
          scrollTop adjustments during streaming reflow would otherwise read
          as "user scrolled up" against our own distance-from-bottom check
          and falsely detach follow mode (MET-104). */}
      <div
        ref={scrollElRef}
        onScroll={handleScroll}
        onWheel={(event) => {
          if (event.deltaY !== 0) wheelIntent.current = true;
        }}
        onPointerDown={() => {
          pointerHeld.current = true;
        }}
        onPointerUp={() => {
          pointerHeld.current = false;
        }}
        onPointerCancel={() => {
          pointerHeld.current = false;
        }}
        data-transcript-viewport
        className="size-full min-h-0 min-w-0 overflow-y-auto overscroll-contain px-3 pt-3 [overflow-anchor:none]"
      >
        <div
          style={{
            position: "relative",
            height: rowVirtualizer.getTotalSize(),
            width: "100%",
          }}
        >
          {virtualItems.map((virtualRow) => (
            <TranscriptRowView
              key={virtualRow.key}
              virtualRow={virtualRow}
              row={rows[virtualRow.index]}
              measureElement={rowVirtualizer.measureElement}
              t={t}
            />
          ))}
        </div>
        {/* The composer clearance is a real spacer, not paddingBottom on the
            scroll container: a padding change wouldn't grow the scrollable
            content box, so distance-from-bottom would stay wrong and the
            last row would sit under the overlay with follow mode blind to
            the gap (MET-104). 144px matches the pre-measurement fallback of
            the old pb-36. */}
        <div aria-hidden style={{ height: Math.max(bottomInset, 144) }} />
      </div>
      {/* Tucked into the corner just above the composer cards: the overlay
          begins with ~40px of transparent gradient (pt-10), so backing off
          from its measured top keeps the button visually next to the
          prompt box rather than floating high above it. */}
      {/* Always mounted, shown/hidden via data-active so it keeps the
          primitive button's slide-and-fade (MessageScrollerButton's
          direction=end treatment) without importing its scroll logic. */}
      <Button
        variant="outline"
        size="icon"
        data-active={!pinned}
        aria-label={t("agentScrollToEnd")}
        title={t("agentScrollToEnd")}
        className="absolute end-3 size-7 rounded-full border-border bg-background text-foreground shadow-sm transition-[translate,scale,opacity] duration-200 hover:bg-muted hover:text-foreground [&_svg]:size-3.5 data-[active=false]:pointer-events-none data-[active=false]:translate-y-full data-[active=false]:scale-95 data-[active=false]:opacity-0 data-[active=false]:duration-400 data-[active=false]:ease-[cubic-bezier(0.7,0,0.84,0)] data-[active=true]:translate-y-0 data-[active=true]:scale-100 data-[active=true]:opacity-100 data-[active=true]:ease-[cubic-bezier(0.23,1,0.32,1)]"
        style={{ bottom: Math.max(bottomInset, 144) - 32 }}
        onClick={() => {
          rowVirtualizer.scrollToEnd({ behavior: "smooth" });
          setPinned(true);
        }}
      >
        <ArrowDown className="size-4" />
      </Button>
    </div>
  );
});

/** One absolutely-positioned virtual row. A separate component (not inlined
 *  in the map) so its measureElement ref callback is stable per row identity
 *  rather than a fresh closure every Transcript render. */
function TranscriptRowView({
  virtualRow,
  row,
  measureElement,
  t,
}: {
  virtualRow: VirtualItem;
  row: TranscriptRow;
  measureElement: (node: HTMLDivElement | null) => void;
  t: (key: string) => string;
}) {
  return (
    <div
      data-index={virtualRow.index}
      ref={measureElement}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        transform: `translateY(${virtualRow.start}px)`,
      }}
      // pb-3 (not a flex `gap`, since rows are absolutely positioned):
      // baked into the measured element itself so estimateRowSize and the
      // real ResizeObserver measurement agree on what "this row's height"
      // includes — matches the old gap-3 spacing between transcript items.
      className="pb-3"
    >
      {row.kind === "error" ? (
        <div className="select-text rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400">
          <span className="select-text font-medium">
            {t("agentTurnFailed")}
          </span>{" "}
          {row.turn.error}
        </div>
      ) : (
        <EntryView entry={row.entry} queued={row.queued} />
      )}
    </div>
  );
}

/** Render one transcript entry by type; tool calls are peers of text.
 *  Memoized: a stream chunk replaces only the mutating entry's row object,
 *  so every settled entry skips its re-render (MET-136). */
const EntryView = memo(function EntryView({
  entry,
  queued,
}: {
  entry: AgentEntry;
  queued?: boolean;
}) {
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

  // trim(): models emit whitespace-only chunks around tool calls (a "\n\n"
  // run closed by a tool_call renders as an empty bubble otherwise), and
  // leading/trailing newlines would show inside whitespace-pre-wrap bubbles.
  if (!entry.text?.trim()) return null;
  return <MessageEntry entry={entry} queued={queued} />;
});

/** A user or assistant text message: compact bubble (user) or flat
 *  full-width text (assistant, opencode-style), plus the hover footer. */
function MessageEntry({
  entry,
  queued,
}: {
  entry: AgentEntry;
  queued?: boolean;
}) {
  const isUser = entry.type === "user";
  const text = entry.text?.trim() ?? "";
  return (
    <div
      className={cn(
        "group flex flex-col",
        isUser ? "items-end" : "items-start",
      )}
    >
      {/* opencode-style: agent replies are flat full-width text — the
          bubble is the user's alone, and a compact one at that. */}
      <div
        className={cn(
          // break-words: an unbroken run (a URL, a long path) must wrap
          // inside the bubble, not push past the chat width.
          "select-text break-words",
          isUser
            ? "max-w-[95%] whitespace-pre-wrap rounded-lg bg-primary px-2 py-1 text-xs text-primary-foreground"
            : "w-full max-w-[95%] text-sm leading-relaxed text-foreground",
          queued && "opacity-70",
        )}
      >
        {isUser ? text : <Markdown text={text} />}
        {queued && <QueuedBadge taskId={entry.taskId} turnId={entry.turnId} />}
      </div>
      <MessageFooter text={text} createdAt={entry.createdAt} isUser={isUser} />
    </div>
  );
}

/** "queued" chip + withdraw ✕ inside a queued user bubble. */
function QueuedBadge({ taskId, turnId }: { taskId: string; turnId: string }) {
  const { t } = useTranslation();
  return (
    <span className="mt-1 flex items-center justify-end gap-1.5">
      <span className="rounded-full bg-primary-foreground/20 px-1.5 py-0.5 text-[0.625rem] uppercase tracking-wide">
        {t("agentQueuedBadge")}
      </span>
      <button
        type="button"
        title={t("agentRemoveFromQueue")}
        aria-label={t("agentRemoveFromQueue")}
        className="rounded-full p-0.5 hover:bg-primary-foreground/20"
        onClick={() => removeQueuedPrompt(taskId, turnId)}
      >
        <X className="size-3" />
      </button>
    </span>
  );
}

/**
 * Hover-revealed message footer (opencode-style, MET-94): copy + timestamp
 * for now; revert and the model name join it later. The row always occupies
 * its height so revealing it never reflows the transcript — only opacity
 * changes.
 */
function MessageFooter({
  text,
  createdAt,
  isUser,
}: {
  text: string;
  createdAt?: number;
  isUser: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 px-1 pt-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100",
        isUser && "flex-row-reverse",
      )}
    >
      <CopyTextButton
        text={text}
        withLabel
        iconClassName="size-3"
        className="p-0.5 text-[0.625rem]"
      />
      {/* Replayed history has no createdAt — no time beats a wrong one. */}
      {createdAt !== undefined && (
        <span className="text-[0.625rem] tabular-nums text-muted-foreground">
          {formatEntryTime(createdAt)}
        </span>
      )}
    </div>
  );
}

/** The footer's clock time; the transcript is a single day's scroll in
 *  practice, so hour:minute is enough context. */
function formatEntryTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Compact checklist for a `plan` session update (ACP entries: content/priority/status). */
function PlanView({ plan }: { plan: unknown }) {
  const entries =
    (plan as { entries?: PlanEntry[] } | undefined)?.entries ?? [];
  if (entries.length === 0) return null;
  return (
    <div className="w-full rounded-lg border border-border bg-card px-2.5 py-2 text-xs">
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
              planEntry.status === "completed" &&
                "text-muted-foreground line-through",
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
    <details className="w-full text-sm text-muted-foreground">
      <summary className="cursor-pointer select-none font-semibold">
        {t("agentThinking")}
      </summary>
      <p className="mt-1 select-text whitespace-pre-wrap text-xs leading-relaxed">
        {text}
      </p>
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
const TOOL_NAME_RENDERER: Record<
  string,
  (props: { toolCall: ToolCallUpdate }) => ReactNode
> = {
  author_blob: AuthorBlobCard,
};

/** "authored a question in notes.md" instead of the raw {blobId} JSON result. */
function AuthorBlobCard({ toolCall: call }: { toolCall: ToolCallUpdate }) {
  const { t } = useTranslation();
  const rawInput = call.rawInput as
    | { path?: string; type?: string; id?: string }
    | undefined;
  const status: ToolCallStatus = call.status ?? "pending";
  if (!rawInput?.path || !rawInput.type || !rawInput.id) {
    return <ToolCallCard toolCall={call} />;
  }
  // rawInput.path is whatever the agent sent (usually workspace-relative);
  // locations[0] carries the workspace-resolved absolute path the jump needs.
  const jumpPath = call.locations?.[0]?.path ?? rawInput.path;
  const fileName = rawInput.path.split("/").pop();
  return (
    <div className="flex w-full items-center gap-2 text-xs text-muted-foreground">
      <Sparkles className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">
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

/**
 * One tool call, opencode-style (MET-94 follow-up): calls with file diffs
 * get the changed-files treatment; everything else is a flat line — bold
 * title, muted one-line preview (command, path, or raw input) — that
 * expands in place to the output/input blocks. No card chrome: tool calls
 * are peers of flat text, not framed widgets.
 */
function ToolCallCard({ toolCall: call }: { toolCall: ToolCallUpdate }) {
  const status: ToolCallStatus = call.status ?? "pending";
  const title = call.title ?? call.kind ?? "other";
  const content = call.content ?? [];
  const diffs = content.filter(
    (item): item is Extract<ToolCallContent, { type: "diff" }> =>
      item.type === "diff",
  );

  const rawInput = call.rawInput;
  const failed = status === "failed";
  const inFlight = status === "pending" || status === "in_progress";
  // An empty/absent input must not leave an expandable box with nothing
  // in it — "{}" is nothing.
  const rawInputText = rawInput != null ? rawInputPreview(rawInput) : "";
  const hasRawInput = rawInputText !== "" && rawInputText !== "{}";
  const hasBody = content.length > 0 || hasRawInput;

  // null = follow the default (open when failed — errors must be seen);
  // a boolean is an explicit user toggle that then sticks.
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? failed;

  // The hook above must precede this branch: a streamed tool call GAINS diff
  // content mid-flight (pending → completed), and an early return above any
  // hook would shrink the hook count across renders and tear the tab down.
  if (diffs.length > 0) {
    return <ChangedFilesCard diffs={diffs} status={status} />;
  }

  return (
    <div className="w-full text-xs">
      <button
        type="button"
        onClick={() => hasBody && setOverride(!open)}
        className={cn(
          "group/tool flex w-full items-center gap-2 text-left",
          hasBody && "cursor-pointer",
        )}
      >
        <span
          className={cn(
            // min-w-0 + truncate, not shrink-0: adapters mint titles from
            // whatever they like (a full shell command, a long MCP name) —
            // the row must ellipsize inside the chat width, never overflow.
            "min-w-0 shrink truncate font-semibold",
            failed && "text-destructive",
            // In flight, the title's own shimmer IS the loading state —
            // no spinner, no placeholder box.
            inFlight && "shimmer text-muted-foreground",
          )}
        >
          {title}
        </span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground/70">
          {toolPreview(call)}
        </span>
        {hasBody && (
          <ChevronRight
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              open ? "rotate-90" : "opacity-0 group-hover/tool:opacity-100",
            )}
          />
        )}
      </button>

      {hasBody && open && (
        <div className="mt-1.5 flex flex-col gap-2">
          {content.map((item, i) => (
            <ToolContentView key={i} item={item} />
          ))}
          {content.length === 0 && hasRawInput && (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-border/60 p-2 font-mono text-[0.6875rem] text-muted-foreground">
              {rawInputText}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/** The collapsed line's context: the command for shell-ish calls, the
 *  primary file for file-ish ones, raw input as the fallback. */
function toolPreview(call: ToolCallUpdate): string {
  const rawInput = call.rawInput as { command?: unknown } | undefined;
  if (typeof rawInput?.command === "string") return rawInput.command;
  const path = call.locations?.[0]?.path;
  if (path) return path;
  return call.rawInput ? rawInputPreview(call.rawInput) : "";
}

/**
 * The diff-bearing call's special face (kept from the card era, restyled):
 * a "N changed files" headline with total +/− line counts, then one row
 * per file — dimmed directory, bold basename, per-file counts — each
 * expanding to its diff text in place.
 */
function ChangedFilesCard({
  diffs,
  status,
}: {
  diffs: Extract<ToolCallContent, { type: "diff" }>[];
  status: ToolCallStatus;
}) {
  const { t } = useTranslation();
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const counts = diffs.map((diff) => ({
    added: diff.newText ? diff.newText.split("\n").length : 0,
    removed: diff.oldText != null ? diff.oldText.split("\n").length : 0,
  }));
  const totalAdded = counts.reduce((sum, c) => sum + c.added, 0);
  const totalRemoved = counts.reduce((sum, c) => sum + c.removed, 0);
  const inFlight = status === "pending" || status === "in_progress";

  return (
    <div className="w-full text-xs">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "min-w-0 truncate font-semibold",
            inFlight && "shimmer text-muted-foreground",
          )}
        >
          {t("agentChangedFiles", { count: diffs.length })}
        </span>
        <span className="text-green-600 dark:text-green-400">
          +{totalAdded}
        </span>
        {totalRemoved > 0 && (
          <span className="text-destructive">−{totalRemoved}</span>
        )}
      </div>
      <div className="mt-1.5 divide-y divide-border/60 overflow-hidden rounded-lg border border-border">
        {diffs.map((diff, i) => {
          const slash = diff.path.lastIndexOf("/");
          const dir = slash >= 0 ? diff.path.slice(0, slash + 1) : "";
          const base = slash >= 0 ? diff.path.slice(slash + 1) : diff.path;
          const open = openIndex === i;
          return (
            <div key={`${diff.path}-${i}`}>
              <button
                type="button"
                onClick={() => setOpenIndex(open ? null : i)}
                className="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-muted/40"
              >
                <span className="min-w-0 flex-1 truncate">
                  <span className="text-muted-foreground">{dir}</span>
                  <span className="font-semibold">{base}</span>
                </span>
                <span className="shrink-0 text-green-600 dark:text-green-400">
                  +{counts[i].added}
                </span>
                {diff.oldText != null && (
                  <span className="shrink-0 text-destructive">
                    −{counts[i].removed}
                  </span>
                )}
                <ChevronRight
                  className={cn(
                    "size-3.5 shrink-0 text-muted-foreground transition-transform",
                    open && "rotate-90",
                  )}
                />
              </button>
              {open && (
                <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all border-t border-border/60 p-2 font-mono text-[0.6875rem]">
                  {diff.newText}
                </pre>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ToolStatusIcon({ status }: { status: ToolCallStatus }) {
  if (status === "completed") {
    return (
      <Check className="size-3.5 shrink-0 text-green-600 dark:text-green-400" />
    );
  }
  if (status === "failed") {
    return <X className="size-3.5 shrink-0 text-destructive" />;
  }
  return (
    <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
  );
}

function ToolContentView({ item }: { item: ToolCallContent }) {
  const { t } = useTranslation();
  if (item.type === "diff") {
    const added = item.newText ? item.newText.split("\n").length : 0;
    const removed = item.oldText ? item.oldText.split("\n").length : 0;
    return (
      <div className="overflow-hidden rounded border border-border/60">
        <div className="flex items-center gap-2 bg-muted/60 px-2 py-1 font-mono text-[0.6875rem]">
          <span className="min-w-0 flex-1 truncate">{item.path}</span>
          <span className="shrink-0 text-green-600 dark:text-green-400">
            +{added}
          </span>
          {item.oldText != null && (
            <span className="shrink-0 text-destructive">−{removed}</span>
          )}
        </div>
        <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all p-2 font-mono text-[0.6875rem]">
          {item.newText}
        </pre>
      </div>
    );
  }
  if (item.type === "terminal") {
    return (
      <span className="font-mono text-[0.6875rem] text-muted-foreground">
        {t("agentTerminal", { id: item.terminalId })}
      </span>
    );
  }
  // { type: "content", content: ContentBlock }
  const block = item.content;
  if (block.type === "text") {
    return (
      <pre className="max-h-56 select-text overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/60 p-2 font-mono text-[0.6875rem]">
        {block.text}
      </pre>
    );
  }
  return (
    <span className="text-[0.6875rem] text-muted-foreground">
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
 * the prompt input above a toolbar row. One action button (MET-104): Stop
 * while a turn runs and the input is empty; typing flips it to Send, which
 * queues the prompt while running (FIFO, lossless). ⏎ sends, ⇧⏎ inserts a
 * newline. The left affordances mirror the target design; they are visual
 * placeholders until wired to real actions.
 */
function PromptBox({
  value,
  onChange,
  onSend,
  onStop,
  onCancelRestore,
  isRunning,
  disabled = false,
  harnessId,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  /** Escape while a turn runs: cancel it and restore the sent prompt. */
  onCancelRestore: () => void;
  isRunning: boolean;
  /** Session history is loading (session/load) — no inputs until it lands. */
  disabled?: boolean;
  harnessId: string;
}) {
  const { t } = useTranslation();
  const harnessLabel = useHarnessLabel(harnessId);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useAutosizeTextarea(textareaRef, value);
  // autoFocus can't fire on a disabled textarea — refocus once the session
  // load finishes and the composer opens up.
  useEffect(() => {
    if (!disabled) textareaRef.current?.focus();
  }, [disabled]);
  return (
    <div className="pointer-events-auto rounded-2xl border border-border bg-card shadow-lg shadow-black/5 dark:shadow-black/40">
      <textarea
        ref={textareaRef}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        // autoFocus: mount == tab selected (the dock unmounts unselected
        // tabs), and pulling focus into the dock is also what keeps the
        // tab hotkeys (Ctrl+Tab, ⌘W, ⌘1-9) alive — they listen on the
        // dockable container, the way editors self-focus on tab-select.
        autoFocus
        onKeyDown={(event) => {
          const action = deriveComposerKeyAction({
            key: event.key,
            shiftKey: event.shiftKey,
            draftEmpty: value.trim().length === 0,
            canRevert: false,
            inFlight: isRunning,
          });
          // Idle "escape" stays a no-op here — the chat tab has no
          // document editor to hand focus back to.
          if (action.type !== "send" && action.type !== "cancelRestore") return;
          event.preventDefault();
          if (action.type === "send") onSend();
          else onCancelRestore();
        }}
        placeholder={
          disabled ? t("agentLoadingSession") : t("agentPromptPlaceholder")
        }
        rows={2}
        className="min-h-[2.75rem] w-full resize-none overflow-hidden bg-transparent px-4 pt-3 text-sm placeholder:text-muted-foreground focus-visible:outline-none disabled:opacity-60"
      />
      <div className="flex items-center gap-1 px-2 pb-2">
        {/* The session is pinned to one harness — a passive indicator, not
            a picker (the sidebar's new-session split button chooses). */}
        <span className="flex items-center gap-1.5 px-1.5 text-[0.6875rem] text-muted-foreground">
          <HarnessLogo harnessId={harnessId} className="size-3" />
          {harnessLabel}
        </span>

        <div className="ms-auto flex items-center gap-1">
          <ComposerActionButton
            isRunning={isRunning}
            draftEmpty={value.trim().length === 0}
            inputsDisabled={disabled}
            onSend={onSend}
            onStop={onStop}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * The composer's single morphing action button (MET-104): Stop while a turn
 * runs and nothing is typed, Send otherwise — which queues while running.
 * The mode/enabled decision lives in the pure deriveComposerButton.
 */
function ComposerActionButton({
  isRunning,
  draftEmpty,
  inputsDisabled,
  onSend,
  onStop,
}: {
  isRunning: boolean;
  draftEmpty: boolean;
  inputsDisabled: boolean;
  onSend: () => void;
  onStop: () => void;
}) {
  const { t } = useTranslation();
  const button = deriveComposerButton({
    isRunning,
    draftEmpty,
    inputsDisabled,
  });
  const label =
    button.mode === "stop"
      ? t("agentStop")
      : button.mode === "queue"
        ? t("agentQueue")
        : t("agentSend");
  return (
    <Button
      size="icon"
      variant={button.mode === "stop" ? "outline" : "default"}
      onClick={button.mode === "stop" ? onStop : onSend}
      disabled={!button.enabled}
      className="size-9 rounded-xl"
      title={label}
      aria-label={label}
    >
      {button.mode === "stop" ? (
        <Square className="fill-current" />
      ) : (
        <ArrowUp />
      )}
    </Button>
  );
}

/** Label for a harness id — effective list first (covers custom entries and
 *  overrides), built-ins as fallback (a deleted custom entry's sessions keep
 *  the raw id), raw id last. */
function useHarnessLabel(harnessId: string): string {
  const effective = useActiveHarnesses();
  return (
    effective.find((harness) => harness.id === harnessId)?.label ??
    BUILT_IN_HARNESSES.find((harness) => harness.id === harnessId)?.label ??
    harnessId
  );
}
