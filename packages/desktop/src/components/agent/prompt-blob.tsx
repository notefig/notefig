// Pre-existing tangle: editor-store builds the editor kit with
// ai-prompt-node, whose node view renders this component. Untangling means
// relocating the editor registry to a leaf module (see file-sync's
// editor-store import comment); new cycles elsewhere still gate.
// fallow-ignore-file circular-dependency
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useLiveQuery, eq, and } from "@tanstack/react-db";
import { useHotkey } from "@tanstack/react-hotkeys";
import { useTranslation } from "react-i18next";
import {
  Check,
  FileText,
  Loader2,
  MessageSquare,
  Pencil,
  RotateCw,
  Square,
  TriangleAlert,
  X,
} from "lucide-react";
import { toast } from "sonner";
import type { Editor } from "@tiptap/core";
import { useAutosizeTextarea } from "@/hooks/use-autosize-textarea";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useKv } from "@/utils/kv-store";
import { normalizePath, getFileName } from "@/utils/fs";
import {
  agentEntriesCollection,
  agentPermissionRequestsCollection,
  agentTasksCollection,
  agentTurnsCollection,
} from "@/agent/agent-collections";
import { agents } from "@/agent/agents";
import {
  cancelAgentTask,
  cancelAgentTurnAndForget,
  removeQueuedPrompt,
} from "@/agent/agent-service";
import { getRegisteredTask } from "@/agent/task-registry";
import type { WidgetResponse } from "@/agent/tools/widget-respond";
import { ensureAgentRuntime } from "@/agent/tunnel/require-connection";
import { useWorkspaceTabs } from "@/components/workspace-tabs-provider";
import { suppressEditorFocus } from "@/components/editor/editor-store";
import { useDefaultHarness } from "@/hooks/use-harness-selection";
import { HarnessLogo } from "./harness-logo";
import { AuthCard } from "./agent-chat-tab";
import { CopyTextButton } from "./copy-text-button";
import { PermissionCard } from "./permission-card";
import {
  getOrStartSharedSession,
  dropSharedSession,
  peekSharedSession,
  adoptSharedSession,
} from "./blob-session-store";
import { describeTaskMeta, useAgentTaskList } from "@/entities/agents";
import { docHasRealContent } from "@/components/editor/ai-prompt-utils";
import {
  getPromptBlob,
  updatePromptBlob,
  clearPromptBlobTurn,
  subscribePromptBlob,
  subscribePromptBlobFocus,
  consumePendingPromptBlobFocus,
} from "./prompt-blob-store";
import {
  derivePhase,
  deriveActiveToolLine,
  deriveLatestAssistantLine,
  deriveTouchedFiles,
  deriveQueuePosition,
  deriveComposerKeyAction,
  deriveWidgetResponse,
  deriveDoneLine,
  widgetPromptTarget,
  blobCardClass,
  type BlobPhase,
} from "./prompt-blob-state";

/**
 * Which mounted widgets currently have a turn in flight, blobId → bound
 * turnId. Several widgets in one document can be in flight at once, and
 * each registers the same global Escape hotkey — the one bound to the
 * newest turn (ids are ascending, same ordering deriveQueuePosition
 * relies on) is the one Escape acts on.
 */
const inFlightEscapeClaims = new Map<string, string>();

function claimInFlightEscape(blobId: string, turnId: string): () => void {
  inFlightEscapeClaims.set(blobId, turnId);
  return () => {
    inFlightEscapeClaims.delete(blobId);
  };
}

function holdsLatestInFlightEscape(blobId: string): boolean {
  const mine = inFlightEscapeClaims.get(blobId);
  if (!mine) return false;
  for (const turnId of inFlightEscapeClaims.values()) {
    if (turnId > mine) return false;
  }
  return true;
}

/**
 * The inline prompt blob: the primary prompting surface, hosted by the
 * aiPrompt document node (ai-prompt-node.tsx) — part of the markdown AST in
 * the editor, present by default in empty documents, but serialized to
 * nothing so it never touches the file on disk. All interaction for the
 * turn it sends stays here — progress, transient tool activity, stop/edit,
 * auth and permission prompts, and the touched-documents summary — so the
 * chat tab is optional, opened only from the done-state affordance.
 *
 * State lives in prompt-blob-store (module-level, per document path): the
 * dock unmounts unselected tabs, and a running turn must survive that.
 * Turns queue into the shared per-workspace session (blob-session-store);
 * each widget watches only its own bound turnId.
 */
export const PromptBlob = memo(function PromptBlob({
  blobId,
  workspacePath,
  documentPath,
  editor,
  getPos,
  summoned = false,
  removeNode,
}: {
  /** This widget instance's identity (the node's blobId attr) — the store
   *  key. Documents can hold several widgets; the path is not identity. */
  blobId: string;
  workspacePath: string;
  documentPath: string;
  editor: Editor;
  /** The node view's live position getter — read at send() time and handed
   *  to agents.task(taskId).promptFromWidget, which anchors the
   *  widget-context resource to where in the document the prompt was sent
   *  from. */
  getPos?: () => number | undefined;
  /** True when this instance was summoned by typing "/" — arms the
   *  revert-to-"/" contract (Esc / second "/" in the empty composer). */
  summoned?: boolean;
  /** Remove this widget's document node; insertSlash leaves a literal "/"
   *  in its place, restoreParagraph leaves a plain empty paragraph (the
   *  Backspace-dismiss path). Provided by the node view (getPos/deleteNode). */
  removeNode?: (options?: {
    insertSlash?: boolean;
    restoreParagraph?: boolean;
  }) => void;
}) {
  const { t } = useTranslation();
  const record = useSyncExternalStore(
    useCallback((cb) => subscribePromptBlob(blobId, cb), [blobId]),
    () => getPromptBlob(blobId),
  );
  const { boundTurnId, boundTaskId } = record;
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const { defaultHarness } = useDefaultHarness();
  const { openFile, openAgentTab } = useWorkspaceTabs();
  const {
    isSending,
    confirmTrust,
    setDraft,
    send,
    sendFollowUp,
    editPrompt,
    retry,
    stop,
    cancelAndRestore,
    dismiss,
    revertToSlash,
    backspaceDismiss,
  } = usePromptBlobActions({
    blobId,
    workspacePath,
    documentPath,
    editor,
    getPos,
    summoned,
    removeNode,
    textareaRef,
  });

  // Live rows for the bound turn (sentinel ids keep the hooks unconditional).
  const turnKey = boundTurnId ?? " none";
  const taskKey = boundTaskId ?? " none";
  const { data: turnRows = [] } = useLiveQuery(
    (q) =>
      q
        .from({ turn: agentTurnsCollection })
        .where(({ turn }) => eq(turn.turnId, turnKey)),
    [turnKey],
  );
  const { data: taskRows = [] } = useLiveQuery(
    (q) =>
      q
        .from({ task: agentTasksCollection })
        .where(({ task }) => eq(task.taskId, taskKey)),
    [taskKey],
  );
  const { data: turnEntries = [] } = useLiveQuery(
    (q) =>
      q
        .from({ entry: agentEntriesCollection })
        .where(({ entry }) => eq(entry.turnId, turnKey)),
    [turnKey],
  );
  const { data: taskTurns = [] } = useLiveQuery(
    (q) =>
      q
        .from({ turn: agentTurnsCollection })
        .where(({ turn }) => eq(turn.taskId, taskKey)),
    [taskKey],
  );
  const { data: pendingPermissions = [] } = useLiveQuery(
    (q) =>
      q
        .from({ req: agentPermissionRequestsCollection })
        .where(({ req }) =>
          and(eq(req.taskId, taskKey), eq(req.status, "pending")),
        ),
    [taskKey],
  );

  const turn = turnRows[0];
  const task = taskRows[0];
  const sortedEntries = useMemo(
    () => [...turnEntries].sort((a, b) => (a.id < b.id ? -1 : 1)),
    [turnEntries],
  );

  const phase: BlobPhase = derivePhase({
    turn,
    task,
    hasPendingPermission: pendingPermissions.length > 0,
    isSending,
  });

  // Escape anywhere cancels this widget's in-flight turn and restores the
  // prompt into the composer (MET-94). A global hotkey, not a card-level
  // keydown: after send the composer unmounts and focus returns to the
  // document, so no element inside the widget could hear the key. The dock
  // unmounting unselected tabs scopes it to the visible document for free;
  // "sending" is excluded (nothing to cancel yet — the dispatch is still
  // racing the session spawn, a sub-second window).
  const inFlight =
    phase === "queued" ||
    phase === "running" ||
    phase === "needs-permission" ||
    phase === "needs-auth";
  useEffect(() => {
    if (!inFlight || !boundTurnId) return;
    return claimInFlightEscape(blobId, boundTurnId);
  }, [inFlight, boundTurnId, blobId]);
  useHotkey(
    "Escape",
    (event) => {
      // A layer that consumed the key (dialog/menu dismissal) wins.
      if (event.defaultPrevented) return;
      if (!holdsLatestInFlightEscape(blobId)) return;
      cancelAndRestore();
    },
    // 'allow': several widgets can legitimately hold this registration;
    // the latest-sent claim decides which one acts.
    { enabled: inFlight, conflictBehavior: "allow" },
  );

  // Stale bound turn (app restart / task disposed): rows are gone — unbind
  // and fall back to composing instead of rendering a dead shell.
  const isStale = boundTurnId !== null && !isSending && turn === undefined;
  useEffect(() => {
    if (isStale) clearPromptBlobTurn(blobId);
  }, [isStale, blobId]);

  const focusComposer = useCallback(() => {
    // suppressEditorFocus first: the arbiter routes focus to the editor on
    // new-file creation (and "/" leaves the editor holding focus) — it
    // would win the race otherwise.
    suppressEditorFocus();
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  // Focus requests from the "/" summon: a pending request may predate this
  // mount (the node view renders one React pass after the insert), then
  // stay subscribed for requests while mounted (empty-doc "/" focuses the
  // existing keeper widget).
  useEffect(() => {
    if (consumePendingPromptBlobFocus(blobId)) focusComposer();
    return subscribePromptBlobFocus(blobId, focusComposer);
  }, [blobId, focusComposer]);

  // Auto-active on empty documents, on mount only. Beyond this and the
  // summon channel above, only explicit user actions (Edit) call focus().
  const autoFocused = useRef(false);
  useEffect(() => {
    if (autoFocused.current) return;
    autoFocused.current = true;
    const { draft, boundTurnId: bound } = getPromptBlob(blobId);
    if (editor.state.doc.textContent.trim() !== "" || draft || bound) return;
    // Only for newly opened empty docs. When a doc becomes empty mid-edit
    // (select-all + delete), the keeper reinsert remounts this widget — the
    // user's cursor is in the editor and must stay there.
    if (editor.view.hasFocus()) return;
    focusComposer();
  }, [blobId, editor, focusComposer]);

  const touchedFiles = useMemo(
    () =>
      phase === "done" ? deriveTouchedFiles(sortedEntries, workspacePath) : [],
    [phase, sortedEntries, workspacePath],
  );
  const widgetResponse = useMemo(
    () => (phase === "done" ? deriveWidgetResponse(sortedEntries) : null),
    [phase, sortedEntries],
  );
  const rawActiveToolLine =
    phase === "running" ? deriveActiveToolLine(sortedEntries) : null;
  const activeToolLine = useDebouncedActiveToolLine(rawActiveToolLine);
  // Running: live teaser under the status line. Done: the fallback summary
  // line when the turn has no widget_respond response.
  const assistantTeaser =
    phase === "running" || phase === "done"
      ? deriveLatestAssistantLine(sortedEntries)
      : null;
  const queueAhead =
    phase === "queued" && boundTurnId
      ? deriveQueuePosition(taskTurns, boundTurnId)
      : 0;

  return (
    <div
      // The widget claims its pointer events wholesale: ProseMirror must
      // not turn clicks on its controls into node selections, and the
      // editor's gutter-click focus handler must not grab them either.
      onMouseDown={(event) => event.stopPropagation()}
      className="w-full"
    >
      <AnimatedHeight>
        <div
          className={cn(
            "rounded-lg border",
            blobCardClass(phase, widgetResponse?.kind === "issue"),
          )}
        >
          {phase === "composing" && (
            <Composer
              draft={record.draft}
              setDraft={setDraft}
              onSend={() => void send()}
              onEscape={() => editor.commands.focus()}
              onRevert={revertToSlash}
              onBackspaceDismiss={backspaceDismiss}
              confirmTrust={confirmTrust}
              trustName={defaultHarness.label}
              workspacePath={workspacePath}
              textareaRef={textareaRef}
            />
          )}

          {phase === "sending" && <StatusRow shimmer prompt={record.draft} />}

          {phase === "queued" && (
            <StatusRow
              label={
                queueAhead > 0
                  ? t("promptBlobQueuedAhead", { count: queueAhead })
                  : t("promptBlobQueued")
              }
              prompt={record.lastSentPrompt}
              onEdit={editPrompt}
              onStop={stop}
              stopLabel={t("agentRemoveFromQueue")}
            />
          )}

          {(phase === "running" || phase === "needs-permission") && (
            <div className="flex flex-col">
              <StatusRow
                // No filler label: the tool-activity line exists only while
                // a tool is actually in flight — the spinner alone carries
                // "working", and a permanent "Working…" line just pads the
                // row (Parsa's spacing complaint).
                label={activeToolLine ?? undefined}
                shimmer
                prompt={record.lastSentPrompt}
                teaser={assistantTeaser ?? undefined}
                onEdit={editPrompt}
                onStop={stop}
                stopLabel={t("agentStop")}
              />
              {phase === "needs-permission" && boundTaskId && (
                <div className="px-2.5 pb-2">
                  <PermissionCard taskId={boundTaskId} bare />
                </div>
              )}
            </div>
          )}

          {phase === "needs-auth" && task && (
            <div className="flex flex-col">
              <StatusRow
                label={t("agentSignInRequired")}
                prompt={record.lastSentPrompt}
                onEdit={editPrompt}
                onStop={stop}
                stopLabel={t("agentStop")}
              />
              <div className="px-2.5 pb-2">
                <AuthCard task={task} bare />
              </div>
            </div>
          )}

          {phase === "done" && (
            <DoneState
              cancelled={turn?.status === "cancelled"}
              response={widgetResponse}
              fallbackText={assistantTeaser}
              touchedFiles={touchedFiles}
              onOpenFile={(path) =>
                openFile({ tabId: path, intent: "new-tab" })
              }
              onOpenChat={() => boundTaskId && openAgentTab(boundTaskId)}
              onDismiss={dismiss}
              replyDraft={record.draft}
              setReplyDraft={setDraft}
              onReply={() => void sendFollowUp()}
              onReplyEscape={() => editor.commands.focus()}
              replyDisabled={isSending}
            />
          )}

          {phase === "error" && (
            <ErrorState
              message={turn?.error}
              onRetry={retry}
              onEdit={editPrompt}
              onDismiss={dismiss}
              replyDraft={record.draft}
              setReplyDraft={setDraft}
              onReply={() => void sendFollowUp()}
              onReplyEscape={() => editor.commands.focus()}
              replyDisabled={isSending}
            />
          )}
        </div>
      </AnimatedHeight>
    </div>
  );
});

/**
 * The shared first half of Stop and Escape-cancel: resolve the widget's
 * bound round, and when it's still queued withdraw it (which returns the
 * prompt text to the composing face — not an empty box, MET-94). Returns
 * the bound task for the caller's running-turn handling, or null when
 * there was nothing left to act on (unbound, or withdrawn here).
 */
function withdrawIfQueued(
  blobId: string,
  restorePromptToDraft: () => void,
): { taskId: string } | null {
  const { boundTaskId, boundTurnId } = getPromptBlob(blobId);
  if (!boundTaskId || !boundTurnId) return null;
  if (agentTurnsCollection.get(boundTurnId)?.status === "queued") {
    removeQueuedPrompt(boundTaskId, boundTurnId);
    restorePromptToDraft();
    return null;
  }
  return { taskId: boundTaskId };
}

/**
 * The widget's send paths (round one + reply), split out of
 * usePromptBlobActions so each hook stays readable: this one owns the
 * trust gate, the in-flight flag, and the prompt dispatch; the parent
 * composes it with the withdraw/restore/dismiss actions.
 */
function usePromptSendActions({
  blobId,
  workspacePath,
  documentPath,
  editor,
  getPos,
}: {
  blobId: string;
  workspacePath: string;
  documentPath: string;
  editor: Editor;
  getPos?: () => number | undefined;
}) {
  const { t } = useTranslation();
  const { defaultHarness } = useDefaultHarness();
  const kv = useKv<boolean>("agent");
  const trustKey = `trust:${normalizePath(workspacePath)}`;
  const [isSending, setIsSending] = useState(false);
  const [confirmTrust, setConfirmTrust] = useState(false);

  // The one prompt dispatch both send paths share: they differ only in
  // which task they target and whether the rebind captures it. The
  // widget-context facts are read fresh on every call — a reply may follow
  // a round that filled the doc or moved the node.
  const dispatchPrompt = useCallback(
    (taskId: string, text: string) => {
      const doc = editor.state.doc;
      return agents.task(taskId).promptFromWidget(
        text,
        widgetPromptTarget({
          documentPath,
          workspacePath,
          pos: getPos?.(),
          docContentSize: doc.content.size,
          isDocEmpty: !docHasRealContent(doc),
        }),
      ).turnId;
    },
    [documentPath, workspacePath, editor, getPos],
  );

  const send = useCallback(async () => {
    const text = getPromptBlob(blobId).draft.trim();
    if (!text || isSending) return;
    if (!ensureAgentRuntime()) return;
    if (!kv.get(trustKey) && !confirmTrust) {
      setConfirmTrust(true);
      return;
    }
    if (confirmTrust) {
      kv.set(trustKey, true);
      setConfirmTrust(false);
    }
    setIsSending(true);
    try {
      const { taskId } = await getOrStartSharedSession(
        workspacePath,
        defaultHarness,
      );
      const turnId = dispatchPrompt(taskId, text);
      updatePromptBlob(blobId, {
        boundTurnId: turnId,
        boundTaskId: taskId,
        lastSentPrompt: text,
        draft: "",
      });
    } catch (error) {
      console.error("Prompt blob send failed:", error);
    } finally {
      setIsSending(false);
    }
  }, [
    blobId,
    isSending,
    kv,
    trustKey,
    confirmTrust,
    workspacePath,
    defaultHarness,
    dispatchPrompt,
  ]);

  // Reply (MET-92): continue the conversation on the BOUND task — never the
  // shared session, which the picker may have re-targeted since this
  // widget's first round. A new FIFO turn on the same ACP session; the
  // rebind below is the whole "replace the round behind the scenes". No
  // trust gate: round one already required it for this workspace.
  const sendFollowUp = useCallback(async () => {
    const current = getPromptBlob(blobId);
    const text = current.draft.trim();
    const taskId = current.boundTaskId;
    if (!text || isSending || !taskId) return;
    if (!ensureAgentRuntime()) return;
    // agents.task().prompt is infallible: a missing task mints a turnId
    // with no row, and binding to it would trip the stale-turn reset —
    // silently wiping this reply. Check first; on a dead task keep the
    // draft and fall back to composing (re-send starts a fresh session).
    if (!getRegisteredTask(taskId)) {
      toast(t("promptBlobSessionGone"));
      clearPromptBlobTurn(blobId);
      return;
    }
    setIsSending(true);
    try {
      const turnId = dispatchPrompt(taskId, text);
      updatePromptBlob(blobId, {
        boundTurnId: turnId,
        lastSentPrompt: text,
        draft: "",
      });
    } finally {
      setIsSending(false);
    }
  }, [blobId, isSending, dispatchPrompt, t]);

  return { isSending, confirmTrust, send, sendFollowUp };
}

/**
 * The widget's imperative actions, extracted from PromptBlob so the
 * component body stays layout + phase branching (the callbacks were the
 * bulk of its size). Every callback reads the module store / collections at
 * call time rather than closing over live-query rows, so the hook needs no
 * reactive inputs and its callbacks stay stable across phase changes.
 */
function usePromptBlobActions({
  blobId,
  workspacePath,
  documentPath,
  editor,
  getPos,
  summoned,
  removeNode,
  textareaRef,
}: {
  blobId: string;
  workspacePath: string;
  documentPath: string;
  editor: Editor;
  getPos?: () => number | undefined;
  summoned: boolean;
  removeNode?: (options?: {
    insertSlash?: boolean;
    restoreParagraph?: boolean;
  }) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement>;
}) {
  const { isSending, confirmTrust, send, sendFollowUp } = usePromptSendActions({
    blobId,
    workspacePath,
    documentPath,
    editor,
    getPos,
  });

  const setDraft = useCallback(
    (draft: string) => updatePromptBlob(blobId, { draft }),
    [blobId],
  );

  // Unbind and pull the sent prompt back into the composer, then focus it.
  // A draft already being typed (a half-written reply) always wins over the
  // restored prompt. Shared by Edit, Escape-cancel, and queued-Stop.
  const restorePromptToDraft = useCallback(() => {
    const current = getPromptBlob(blobId);
    updatePromptBlob(blobId, {
      draft: current.draft || current.lastSentPrompt,
      boundTurnId: null,
      boundTaskId: null,
    });
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [blobId, textareaRef]);

  // Edit: pull the sent prompt back into the composer. A queued turn is
  // withdrawn; a running/finished one keeps going — re-send is a new turn.
  const editPrompt = useCallback(() => {
    const { boundTaskId, boundTurnId } = getPromptBlob(blobId);
    if (
      boundTaskId &&
      boundTurnId &&
      agentTurnsCollection.get(boundTurnId)?.status === "queued"
    ) {
      removeQueuedPrompt(boundTaskId, boundTurnId);
    }
    restorePromptToDraft();
  }, [blobId, restorePromptToDraft]);

  // Retry: pull the failed prompt back into the composer and immediately
  // re-send it, no re-typing required. editPrompt writes the restored draft
  // into the module-level store synchronously, so send() (which reads the
  // draft at call time) sees it right away.
  const retry = useCallback(() => {
    editPrompt();
    void send();
  }, [editPrompt, send]);

  const stop = useCallback(() => {
    const running = withdrawIfQueued(blobId, restorePromptToDraft);
    if (running) void cancelAgentTask(running.taskId);
  }, [blobId, restorePromptToDraft]);

  // Escape while in flight (MET-94): cancel the turn and — when the agent
  // hadn't responded yet — return to the composing face with the prompt
  // restored, its round forgotten (the restored prompt must not also
  // linger in the history it was pulled out of). Once a response exists
  // the round is real: forgetting it would hide context the session still
  // holds, so Escape then degrades to Stop (stay bound, "Stopped" done
  // face, no restore — the prompt is right there in the round). A queued
  // turn is withdrawn, which already deletes its rows.
  const cancelAndRestore = useCallback(() => {
    const running = withdrawIfQueued(blobId, restorePromptToDraft);
    if (running) {
      void cancelAgentTurnAndForget(running.taskId).then((forgot) => {
        if (forgot) restorePromptToDraft();
      });
    }
  }, [blobId, restorePromptToDraft]);

  // In a doc with real content the widget is transient — ✕ removes the
  // node outright. In an empty doc removal is pointless (the keeper would
  // reinsert), so just reset to composing.
  const dismiss = useCallback(() => {
    clearPromptBlobTurn(blobId);
    if (removeNode && docHasRealContent(editor.state.doc)) removeNode();
  }, [blobId, removeNode, editor]);

  // The revert half of the "/" summon: Esc or a second "/" while the
  // composer is still empty turns the widget back into a literal "/".
  const revertToSlash = useMemo(
    () =>
      summoned && removeNode
        ? () => removeNode({ insertSlash: true })
        : undefined,
    [summoned, removeNode],
  );

  // Backspace on an empty, summoned composer: unlike revertToSlash, no
  // literal "/" is left behind — the widget just disappears, as if "/" was
  // never typed. Same "summoned instances only" guard as revertToSlash.
  const backspaceDismiss = useMemo(
    () =>
      summoned && removeNode
        ? () => removeNode({ restoreParagraph: true })
        : undefined,
    [summoned, removeNode],
  );

  return {
    isSending,
    confirmTrust,
    setDraft,
    send,
    sendFollowUp,
    editPrompt,
    retry,
    stop,
    cancelAndRestore,
    dismiss,
    revertToSlash,
    backspaceDismiss,
  };
}

/**
 * Debounces the tool-activity label the same way the editor status bar
 * debounces "saved" (status-bar.tsx's useDebouncedSyncState): a new label
 * lands immediately, but clearing back to null waits out `delay` — a tool
 * call that starts and finishes inside the window never flashes on and off.
 */
function useDebouncedActiveToolLine(
  label: string | null,
  delay: number = 300,
): string | null {
  const [debounced, setDebounced] = useState(label);
  useEffect(() => {
    if (label !== null) {
      setDebounced(label);
      return;
    }
    const timeout = setTimeout(() => setDebounced(null), delay);
    return () => clearTimeout(timeout);
  }, [label, delay]);
  return debounced;
}

/**
 * Measured-height wrapper so phase changes glide instead of jumping: the
 * inner content is observed with ResizeObserver and its height applied as an
 * animatable inline style (same measurement idiom as the chat tab's composer
 * overlay). Height "auto" is unanimatable in CSS, hence the observer.
 */
function AnimatedHeight({ children }: { children: React.ReactNode }) {
  const innerRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setHeight(el.offsetHeight));
    observer.observe(el);
    setHeight(el.offsetHeight);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      className="overflow-hidden transition-[height] duration-200 ease-out"
      style={height === null ? undefined : { height }}
    >
      <div ref={innerRef}>{children}</div>
    </div>
  );
}

/**
 * The composing face: session control + textarea, one row, no send button —
 * Enter (no Shift) is the only submit. The textarea never remounts across
 * the composing/confirm-trust flip — the trust warning renders alongside it.
 */
function Composer({
  draft,
  setDraft,
  onSend,
  onEscape,
  onRevert,
  onBackspaceDismiss,
  confirmTrust,
  trustName,
  workspacePath,
  textareaRef,
}: {
  draft: string;
  setDraft: (value: string) => void;
  onSend: () => void;
  onEscape: () => void;
  /** Slash-summoned instances only: turn back into a literal "/". Fires on
   *  Esc or "/" while the composer is empty; with a draft, Esc falls back
   *  to onEscape (return to the doc, draft kept). */
  onRevert?: () => void;
  /** Slash-summoned instances only: Backspace on an empty composer removes
   *  the widget entirely (no literal "/" left behind, unlike onRevert). */
  onBackspaceDismiss?: () => void;
  confirmTrust: boolean;
  trustName: string;
  workspacePath: string;
  textareaRef: React.RefObject<HTMLTextAreaElement>;
}) {
  const { t } = useTranslation();
  useAutosizeTextarea(textareaRef, draft);
  return (
    <div className="flex flex-col">
      <div className="flex items-start gap-1.5 px-1.5 py-1">
        <SessionControl workspacePath={workspacePath} />
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            const action = deriveComposerKeyAction({
              key: event.key,
              shiftKey: event.shiftKey,
              draftEmpty: draft.trim().length === 0,
              canRevert: onRevert !== undefined,
              inFlight: false,
            });
            if (action.type === "none") return;
            event.preventDefault();
            if (action.type === "send") onSend();
            else if (action.type === "revert") onRevert?.();
            else if (action.type === "backspaceDismiss") onBackspaceDismiss?.();
            else onEscape();
          }}
          placeholder={t("promptBlobPlaceholder")}
          rows={1}
          className="min-h-[28px] min-w-0 flex-1 resize-none overflow-hidden bg-transparent pt-1 pb-1.5 text-sm placeholder:text-muted-foreground focus-visible:outline-none"
        />
      </div>
      {confirmTrust && (
        <span className="px-3 pb-1.5 text-[11px] text-amber-600 dark:text-amber-400">
          {t("promptBlobTrustWarning", { name: trustName })}
        </span>
      )}
    </div>
  );
}

/**
 * The session picker, logo-only trigger in the composer row: shows where
 * the next prompt actually goes (the adopted session's harness logo, or the
 * default harness if nothing is adopted). The menu offers the workspace's
 * recent live sessions to re-target, or an explicit new session (started on
 * the default harness).
 */
function SessionControl({ workspacePath }: { workspacePath: string }) {
  const { t } = useTranslation();
  const { defaultHarness } = useDefaultHarness();
  const taskMetas = useAgentTaskList(workspacePath);
  const [open, setOpen] = useState(false);

  const peekedTaskId = peekSharedSession(workspacePath);
  const peekedKey = peekedTaskId ?? " none";
  const { data: peekedRows = [] } = useLiveQuery(
    (q) =>
      q
        .from({ task: agentTasksCollection })
        .where(({ task }) => eq(task.taskId, peekedKey)),
    [peekedKey],
  );
  const triggerHarnessId = peekedRows[0]?.harnessId ?? defaultHarness.id;

  const recentSessions = taskMetas
    .filter(
      (meta) =>
        meta.task.status !== "error" &&
        meta.task.status !== "cancelled" &&
        meta.task.status !== "unavailable",
    )
    .slice(0, 5);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 cursor-pointer rounded-lg text-muted-foreground"
          title={t("agentChooseHarness")}
          aria-label={t("agentChooseHarness")}
        >
          <HarnessLogo harnessId={triggerHarnessId} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {recentSessions.length > 0 && (
          <>
            {recentSessions.map((meta) => (
              <DropdownMenuItem
                key={meta.task.taskId}
                className="cursor-pointer gap-2 text-xs"
                onSelect={() =>
                  adoptSharedSession(workspacePath, meta.task.taskId)
                }
              >
                {meta.task.taskId === peekedTaskId ? (
                  <Check className="size-3 shrink-0" />
                ) : (
                  <HarnessLogo
                    harnessId={meta.task.harnessId}
                    className="size-3"
                  />
                )}
                <span className="min-w-0 flex-1 truncate">
                  {meta.task.title}
                </span>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {describeTaskMeta(meta)}
                </span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem
          className="cursor-pointer gap-2 text-xs"
          onSelect={() => dropSharedSession(workspacePath)}
        >
          <MessageSquare className="size-3 text-muted-foreground" />
          {t("promptBlobNewSession")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The in-flight face: the sent prompt for context, and — only while a tool
 * call is actually in flight — a shimmering tool-activity line above it. No
 * label means no line: the spinner alone carries "working", and a filler
 * label would just pad the row. Edit/Stop only show up once there's a bound
 * turn to act on (queued/running/etc.) — the brief pre-turn "sending" face
 * reuses this same row, shimmering, with no buttons. The button slots stay
 * reserved (invisible, not unmounted) either way so the row's width — and
 * the sending→running handoff — doesn't jump when they appear.
 */
function StatusRow({
  label,
  shimmer,
  prompt,
  teaser,
  onEdit,
  onStop,
  stopLabel,
}: {
  label?: string;
  shimmer?: boolean;
  prompt: string;
  /** Latest assistant text, shown instead of `prompt` while running so the
   *  row reflects live progress rather than the static original ask. */
  teaser?: string;
  onEdit?: () => void;
  onStop?: () => void;
  stopLabel?: string;
}) {
  const { t } = useTranslation();
  const secondLine = teaser ?? prompt;
  return (
    <div className="flex items-center gap-2 px-2.5 py-1.5">
      {shimmer && (
        <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
      )}
      <div className="min-w-0 flex-1">
        {label?.trim() && (
          <div
            className={cn(
              "truncate text-xs font-medium capitalize",
              shimmer && "shimmer text-muted-foreground",
            )}
          >
            {label}
          </div>
        )}
        {secondLine.trim() && (
          <div className="truncate text-[11px] text-muted-foreground">
            {secondLine}
          </div>
        )}
      </div>
      <button
        type="button"
        title={t("promptBlobEdit")}
        aria-label={t("promptBlobEdit")}
        disabled={!onEdit}
        className={cn(
          "shrink-0 rounded p-1 text-muted-foreground transition-colors",
          onEdit
            ? "cursor-pointer hover:bg-accent hover:text-foreground"
            : "invisible",
        )}
        onClick={onEdit}
      >
        <Pencil className="size-3.5" />
      </button>
      <button
        type="button"
        title={stopLabel}
        aria-label={stopLabel}
        disabled={!onStop}
        className={cn(
          "shrink-0 rounded p-1 text-muted-foreground transition-colors",
          onStop
            ? "cursor-pointer hover:bg-accent hover:text-foreground"
            : "invisible",
        )}
        onClick={onStop}
      >
        <Square className="size-3.5 fill-current" />
      </button>
    </div>
  );
}

/**
 * The follow-up composer shared by DoneState and ErrorState (MET-92): same
 * store draft as the initial Composer (a half-typed reply survives tab
 * unmount, and Edit's `draft || lastSentPrompt` fallback never destroys it).
 * No SessionControl — the whole point of the row is that the destination is
 * fixed to the bound session. canRevert:false collapses the key map to:
 * Enter sends, Shift+Enter newlines, Escape returns focus to the editor.
 */
function ReplyRow({
  draft,
  setDraft,
  onSend,
  onEscape,
  disabled,
}: {
  draft: string;
  setDraft: (value: string) => void;
  onSend: () => void;
  onEscape: () => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useAutosizeTextarea(textareaRef, draft);
  return (
    <textarea
      ref={textareaRef}
      value={draft}
      disabled={disabled}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        const action = deriveComposerKeyAction({
          key: event.key,
          shiftKey: event.shiftKey,
          draftEmpty: draft.trim().length === 0,
          canRevert: false,
          inFlight: false,
        });
        if (action.type === "none") return;
        event.preventDefault();
        if (action.type === "send") onSend();
        else if (action.type === "escape") onEscape();
      }}
      placeholder={t("promptBlobReply")}
      rows={1}
      className="mt-1 min-h-[24px] w-full resize-none overflow-hidden border-t border-border/60 bg-transparent px-0.5 pt-1.5 text-xs placeholder:text-muted-foreground focus-visible:outline-none"
    />
  );
}

/** The done face's first row: status icon + the one-line outcome summary.
 *  The line doubles as the expand/collapse toggle when there's a body to
 *  show (disabled otherwise — a bare Done/Stopped label has nothing to
 *  expand). Amber tint mirrors the issue callout below. */
function DoneSummaryLine({
  summary,
  expandable,
  expanded,
  isIssue,
  onToggle,
}: {
  summary: string;
  expandable: boolean;
  expanded: boolean;
  isIssue: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      {isIssue ? (
        <TriangleAlert className="size-3 shrink-0 text-amber-600 dark:text-amber-400" />
      ) : (
        <Check className="size-3 shrink-0 text-green-600/80 dark:text-green-400/80" />
      )}
      <button
        type="button"
        disabled={!expandable}
        title={
          expandable
            ? expanded
              ? t("promptBlobShowLess")
              : t("promptBlobShowMore")
            : undefined
        }
        className={cn(
          "min-w-0 flex-1 truncate text-left text-xs",
          isIssue
            ? "text-amber-600 dark:text-amber-400"
            : "text-muted-foreground",
          expandable &&
            "cursor-pointer transition-colors hover:text-foreground",
        )}
        onClick={onToggle}
      >
        {summary}
      </button>
    </>
  );
}

/** Done: the widget's single resting face — one truncated line of the
 *  turn's outcome, the same ellipsis treatment as the running teaser. The
 *  line prefers the `widget_respond` response (title, else the markdown
 *  itself) and falls back to the turn's last assistant text, so even a
 *  harness that never calls the tool leaves something readable behind.
 *  Clicking the line toggles the full text below (pre-wrap, selectable —
 *  same plain-text treatment as chat's assistant bubbles; the app has no
 *  markdown renderer, and upgrading both surfaces later is one change).
 *  No Edit here: Reply continues the session, ✕ dismisses; rewriting from
 *  scratch is what a fresh widget is for. */
function DoneState({
  cancelled,
  response,
  fallbackText,
  touchedFiles,
  onOpenFile,
  onOpenChat,
  onDismiss,
  replyDraft,
  setReplyDraft,
  onReply,
  onReplyEscape,
  replyDisabled,
}: {
  cancelled: boolean;
  response: WidgetResponse | null;
  /** Latest assistant text of the bound turn — the summary line when the
   *  agent didn't deliver a widget_respond response. */
  fallbackText: string | null;
  touchedFiles: string[];
  onOpenFile: (path: string) => void;
  onOpenChat: () => void;
  onDismiss: () => void;
  replyDraft: string;
  setReplyDraft: (value: string) => void;
  onReply: () => void;
  onReplyEscape: () => void;
  replyDisabled: boolean;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const { summary, body, isIssue } = deriveDoneLine({
    response,
    fallbackText,
    cancelled,
    expanded,
    labels: {
      done: t("promptBlobDone"),
      stopped: t("promptBlobStopped"),
      issue: t("promptBlobIssue"),
    },
  });
  return (
    <div className="flex flex-col gap-0.5 px-2 py-1">
      <div className="flex items-center gap-1.5">
        <DoneSummaryLine
          summary={summary}
          expandable={body !== null}
          expanded={expanded}
          isIssue={isIssue}
          onToggle={() => setExpanded((value) => !value)}
        />
        {body && (
          <CopyTextButton
            text={body}
            className="p-0.5"
            iconClassName="size-3"
          />
        )}
        <button
          type="button"
          title={t("promptBlobOpenChat")}
          aria-label={t("promptBlobOpenChat")}
          className="shrink-0 cursor-pointer rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          onClick={onOpenChat}
        >
          <MessageSquare className="size-3" />
        </button>
        <button
          type="button"
          title={t("promptBlobDismiss")}
          aria-label={t("promptBlobDismiss")}
          className="shrink-0 cursor-pointer rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          onClick={onDismiss}
        >
          <X className="size-3" />
        </button>
      </div>
      {expanded && body && (
        <div
          className={cn(
            "select-text whitespace-pre-wrap text-xs leading-relaxed",
            // Issue text mirrors ErrorState's uniform tinted text, in amber
            // — the card border (blobCardClass) carries the rest; no filled
            // callout box.
            isIssue
              ? "text-amber-600 dark:text-amber-400"
              : "text-foreground/80",
          )}
        >
          {body}
        </div>
      )}
      {touchedFiles.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          {touchedFiles.map((path) => (
            <button
              key={path}
              type="button"
              className="flex cursor-pointer items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              onClick={() => onOpenFile(path)}
            >
              <FileText className="size-3" />
              {getFileName(path)}
            </button>
          ))}
        </div>
      )}
      <ReplyRow
        draft={replyDraft}
        setDraft={setReplyDraft}
        onSend={onReply}
        onEscape={onReplyEscape}
        disabled={replyDisabled}
      />
    </div>
  );
}

/** Failed: the turn error plus Retry (same prompt again) / Edit (rewrite
 *  from scratch, fresh shared-session path) / Dismiss, and the reply row
 *  (say something new on the SAME session — errors don't kill it). */
function ErrorState({
  message,
  onRetry,
  onEdit,
  onDismiss,
  replyDraft,
  setReplyDraft,
  onReply,
  onReplyEscape,
  replyDisabled,
}: {
  message: string | undefined;
  onRetry: () => void;
  onEdit: () => void;
  onDismiss: () => void;
  replyDraft: string;
  setReplyDraft: (value: string) => void;
  onReply: () => void;
  onReplyEscape: () => void;
  replyDisabled: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col px-2.5 py-1.5">
      <div className="flex items-center gap-2">
        <X className="size-3.5 shrink-0 text-destructive" />
        <span className="min-w-0 flex-1 truncate text-xs text-destructive">
          {t("promptBlobFailed")}
          {message ? ` ${message}` : ""}
        </span>
        <button
          type="button"
          title={t("promptBlobRetry")}
          aria-label={t("promptBlobRetry")}
          className="shrink-0 cursor-pointer rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          onClick={onRetry}
        >
          <RotateCw className="size-3.5" />
        </button>
        <button
          type="button"
          title={t("promptBlobEdit")}
          aria-label={t("promptBlobEdit")}
          className="shrink-0 cursor-pointer rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          onClick={onEdit}
        >
          <Pencil className="size-3.5" />
        </button>
        <button
          type="button"
          title={t("promptBlobDismiss")}
          aria-label={t("promptBlobDismiss")}
          className="shrink-0 cursor-pointer rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          onClick={onDismiss}
        >
          <X className="size-3.5" />
        </button>
      </div>
      <ReplyRow
        draft={replyDraft}
        setDraft={setReplyDraft}
        onSend={onReply}
        onEscape={onReplyEscape}
        disabled={replyDisabled}
      />
    </div>
  );
}
