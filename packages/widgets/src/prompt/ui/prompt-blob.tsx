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
import { useHotkey } from "@tanstack/react-hotkeys";
import { useTranslation } from "react-i18next";
import {
  Check,
  FileText,
  MessageSquare,
  Pencil,
  RotateCw,
  Square,
  TriangleAlert,
  X,
} from "lucide-react";
import { toast } from "sonner";
import type { Editor } from "@tiptap/core";
import { Button } from "@notefig/ui/button";
import { OrbLoader } from "@notefig/ui/orb-loader";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@notefig/ui/dropdown-menu";
import { cn } from "@notefig/ui/utils";
import { HarnessLogo } from "@notefig/ui/harness-logo";
import {
  sortEntriesChronologically,
  type AgentEntry,
  type AgentTaskRow,
  type AgentTurn,
  type WidgetResponse,
} from "@notefig/shared/agent";
import {
  PromptEditor,
  type PromptEditorHandle,
} from "../composer/prompt-editor";
import { CopyTextButton } from "./copy-text-button";
import { usePromptWidgetHost } from "../host-context";
import type { PromptWidgetHost } from "../host";
import { docHasRealContent } from "../doc-helpers";
import { basename } from "../basename";
import {
  getPromptBlob,
  updatePromptBlob,
  clearPromptBlobTurn,
  type PromptBlobRecord,
  subscribePromptBlob,
  subscribePromptBlobFocus,
  consumePendingPromptBlobFocus,
} from "../store";
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
} from "../state";

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
 * Where this widget instance sits in the document, and the three ways it may
 * write back to its node. Handed down by the node view — distinct from
 * PromptWidgetHost, which is how the widget reaches the application.
 */
interface PromptBlobPlacement {
  /** This widget instance's identity (the node's blobId attr) — the store
   *  key. Documents can hold several widgets; the path is not identity. */
  blobId: string;
  workspacePath: string;
  documentPath: string;
  editor: Editor;
  /** The node view's live position getter — read at send() time and handed
   *  to the host's dispatchPrompt, which anchors the widget-context
   *  resource to where in the document the prompt was sent from. */
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
  /** Record which agent session this widget's round belongs to on the
   *  document node, so it survives a re-parse and app restarts (MET-163).
   *  Provided by the node view, which owns the node's attributes. */
  onSessionBound?: (taskId: string) => void;
}

/**
 * Where this widget's next prompt goes.
 *
 * A widget restored from the document (MET-163) already belongs to a
 * session, and prompting it must continue that conversation — persisting the
 * binding is pointless if the next prompt opens a new session instead. The
 * workspace's shared session is the entry point only for a widget that has
 * never been sent, or whose session is gone for good.
 *
 * Safe against the phases that look similar: Edit and Escape-cancel unbind
 * the task outright, so a prompt the user pulled back and re-sent is not
 * silently re-targeted at the old session.
 */
export async function resolvePromptTarget(
  host: PromptWidgetHost,
  blobId: string,
  workspacePath: string,
): Promise<string> {
  const bound = getPromptBlob(blobId).boundTaskId;
  if (bound && (await host.isTaskReachable(bound))) return bound;
  return host.startOrGetSharedSession(workspacePath);
}

/**
 * The live rows behind one widget's bound round, and the phase they add up
 * to. Sentinel ids keep the queries unconditional: an unbound widget still
 * runs them, matching nothing.
 */
function usePromptBlobRound({
  boundTurnId,
  boundTaskId,
  isSending,
}: {
  boundTurnId: string | null;
  boundTaskId: string | null;
  isSending: boolean;
}) {
  const host = usePromptWidgetHost();
  const { turn, task, entries, taskTurns, pendingPermissions } = host.useRound({
    turnId: boundTurnId,
    taskId: boundTaskId,
  });
  const sortedEntries = useMemo(
    () => sortEntriesChronologically(entries),
    [entries],
  );

  return {
    turn,
    task,
    sortedEntries,
    taskTurns,
    phase: derivePhase({
      turn,
      task,
      hasPendingPermission: pendingPermissions.length > 0,
      isSending,
    }) as BlobPhase,
  };
}

/**
 * Everything the card shows that is derived from the transcript rather than
 * stored: which files the turn touched, the agent's widget_respond answer,
 * the live tool line, the assistant teaser, and the queue position. Each is
 * scoped to the phases that display it, so a running turn does no done-state
 * work and vice versa.
 */
function usePromptBlobDisplay({
  phase,
  sortedEntries,
  taskTurns,
  boundTurnId,
  workspacePath,
}: {
  phase: BlobPhase;
  sortedEntries: AgentEntry[];
  taskTurns: AgentTurn[];
  boundTurnId: string | null;
  workspacePath: string;
}) {
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

  return {
    touchedFiles,
    widgetResponse,
    activeToolLine,
    assistantTeaser,
    queueAhead,
  };
}

/**
 * Escape anywhere cancels this widget's in-flight turn and restores the
 * prompt into the composer (MET-94). A global hotkey, not a card-level
 * keydown: after send the composer unmounts and focus returns to the
 * document, so no element inside the widget could hear the key. The dock
 * unmounting unselected tabs scopes it to the visible document for free;
 * "sending" is excluded (nothing to cancel yet — the dispatch is still
 * racing the session spawn, a sub-second window).
 */
function useInFlightEscape({
  blobId,
  phase,
  boundTurnId,
  cancelAndRestore,
}: {
  blobId: string;
  phase: BlobPhase;
  boundTurnId: string | null;
  cancelAndRestore: () => void;
}) {
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
}

/**
 * Stale bound turn (app restart / task disposed): rows are gone — unbind and
 * fall back to composing instead of rendering a dead shell.
 */
function useStaleTurnReset({
  blobId,
  boundTurnId,
  isSending,
  hasTurn,
}: {
  blobId: string;
  boundTurnId: string | null;
  isSending: boolean;
  hasTurn: boolean;
}) {
  const isStale = boundTurnId !== null && !isSending && !hasTurn;
  useEffect(() => {
    if (isStale) clearPromptBlobTurn(blobId);
  }, [isStale, blobId]);
}

/**
 * Who holds the caret: the composer's focus channels in, and the hand-off
 * back out to the document.
 */
function usePromptBlobFocus({
  blobId,
  editor,
  documentPath,
  getPos,
  composerRef,
}: {
  blobId: string;
  editor: Editor;
  documentPath: string;
  getPos?: () => number | undefined;
  composerRef: React.RefObject<PromptEditorHandle>;
}) {
  const host = usePromptWidgetHost();
  // Escape back to the document, through the arbiter like every other focus
  // hand-off: an editor intent carrying a before-node caret placement so the
  // cursor returns to where the user was before summoning this widget.
  // Without a position (shouldn't happen while mounted) the resolver's
  // default collapse applies.
  const escapeToEditor = useCallback(() => {
    const pos = getPos?.();
    host.focusDocument(documentPath, {
      reason: "blob-escape",
      // Focus IS in this widget's composer — an explicit hand-off, not an
      // ambient grab, so it may leave the text entry.
      steal: true,
      caretBeforeNode: typeof pos === "number" ? pos : undefined,
    });
  }, [host, documentPath, getPos]);

  const focusComposer = useCallback(() => {
    // Suppress first: the arbiter routes focus to the editor on new-file
    // creation (and "/" leaves the editor holding focus) — it would win the
    // race otherwise.
    host.suppressAmbientFocus();
    requestAnimationFrame(() => composerRef.current?.focus());
  }, [host, composerRef]);

  // Focus requests from the "/" summon: a pending request may predate this
  // mount (the node view renders one React pass after the insert), then stay
  // subscribed for requests while mounted (empty-doc "/" focuses the
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

  return { escapeToEditor };
}

/** What the face renders from the transcript, per phase. */
interface PromptBlobDisplay {
  touchedFiles: string[];
  widgetResponse: ReturnType<typeof deriveWidgetResponse>;
  activeToolLine: string | null;
  assistantTeaser: string | null;
  queueAhead: number;
}

/** Everything the face can do. Grouped so the container hands over one
 *  object instead of a dozen callbacks. */
interface PromptBlobFaceActions {
  setDraft: (draft: string) => void;
  send: () => Promise<void> | void;
  sendFollowUp: () => Promise<void> | void;
  editPrompt: () => void;
  retry: () => void;
  stop: () => void;
  dismiss: () => void;
  // Only armed when the node view supplied removeNode (the "/" contract).
  revertToSlash?: () => void;
  backspaceDismiss?: () => void;
  escapeToEditor: () => void;
  /** Point this widget at a different session (the composer's picker). */
  rebindSession: (taskId: string) => void;
  openBoundChat?: () => void;
  /** Open a touched document in a tab. */
  openFile: (path: string) => void;
  openAgentTab: (taskId: string) => void;
}

/**
 * The four faces of a prompt that has been sent and hasn't finished: the
 * same status row, differing in what it says and what it hangs underneath.
 * Rendering nothing for every other phase keeps the branch in one place
 * rather than spread across the parent's JSX.
 */
function SentFace({
  phase,
  record,
  task,
  boundTaskId,
  display,
  actions,
}: {
  phase: BlobPhase;
  record: PromptBlobRecord;
  task: AgentTaskRow | undefined;
  boundTaskId: string | null;
  display: PromptBlobDisplay;
  actions: PromptBlobFaceActions;
}) {
  const { t } = useTranslation();
  const { slots } = usePromptWidgetHost();

  if (phase === "sending") return <StatusRow shimmer prompt={record.draft} />;

  if (phase === "queued") {
    return (
      <StatusRow
        label={
          display.queueAhead > 0
            ? t("promptBlobQueuedAhead", { count: display.queueAhead })
            : t("promptBlobQueued")
        }
        prompt={record.lastSentPrompt}
        onEdit={actions.editPrompt}
        onStop={actions.stop}
        stopLabel={t("agentRemoveFromQueue")}
        onOpenChat={actions.openBoundChat}
      />
    );
  }

  if (phase === "running" || phase === "needs-permission") {
    return (
      <div className="flex flex-col">
        <StatusRow
          // No filler label: the tool-activity line exists only while a tool
          // is actually in flight — the spinner alone carries "working", and
          // a permanent "Working…" line just pads the row (Parsa's spacing
          // complaint).
          label={display.activeToolLine ?? undefined}
          shimmer
          prompt={record.lastSentPrompt}
          teaser={display.assistantTeaser ?? undefined}
          onEdit={actions.editPrompt}
          onStop={actions.stop}
          stopLabel={t("agentStop")}
          onOpenChat={actions.openBoundChat}
        />
        {phase === "needs-permission" && boundTaskId && (
          <div className="px-2.5 pb-2">
            <slots.PermissionCard taskId={boundTaskId} />
          </div>
        )}
      </div>
    );
  }

  // The task row is what AuthCard reads; without it there is nothing to
  // sign in to.
  if (phase === "needs-auth" && task) {
    return (
      <div className="flex flex-col">
        <StatusRow
          label={t("agentSignInRequired")}
          prompt={record.lastSentPrompt}
          onEdit={actions.editPrompt}
          onStop={actions.stop}
          stopLabel={t("agentStop")}
          onOpenChat={actions.openBoundChat}
        />
        <div className="px-2.5 pb-2">
          <slots.AuthCard task={task} />
        </div>
      </div>
    );
  }

  return null;
}

/**
 * The widget's face: given a phase and the state behind it, which card to
 * show. Purely presentational — every hook, subscription and side effect
 * lives in PromptBlob, so this is the part that can be rendered in a test
 * with plain objects.
 */
export function PromptBlobFace({
  phase,
  record,
  turn,
  task,
  boundTaskId,
  workspacePath,
  trustName,
  confirmTrust,
  isSending,
  display,
  actions,
  composerRef,
}: {
  phase: BlobPhase;
  record: PromptBlobRecord;
  turn: AgentTurn | undefined;
  task: AgentTaskRow | undefined;
  boundTaskId: string | null;
  workspacePath: string;
  trustName: string;
  confirmTrust: boolean;
  isSending: boolean;
  display: PromptBlobDisplay;
  actions: PromptBlobFaceActions;
  composerRef: React.RefObject<PromptEditorHandle>;
}) {
  const { t } = useTranslation();
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
            blobCardClass(phase, display.widgetResponse?.kind === "issue"),
          )}
        >
          {phase === "composing" && (
            <Composer
              draft={record.draft}
              setDraft={actions.setDraft}
              onSend={() => void actions.send()}
              onEscape={actions.escapeToEditor}
              onRevert={actions.revertToSlash}
              onBackspaceDismiss={actions.backspaceDismiss}
              confirmTrust={confirmTrust}
              trustName={trustName}
              workspacePath={workspacePath}
              boundTaskId={boundTaskId}
              onSelectSession={actions.rebindSession}
              composerRef={composerRef}
            />
          )}

          <SentFace
            phase={phase}
            record={record}
            task={task}
            boundTaskId={boundTaskId}
            display={display}
            actions={actions}
          />

          {phase === "done" && (
            <DoneState
              cancelled={turn?.status === "cancelled"}
              response={display.widgetResponse}
              fallbackText={display.assistantTeaser}
              touchedFiles={display.touchedFiles}
              onOpenFile={(path) => actions.openFile(path)}
              onOpenChat={() =>
                boundTaskId && actions.openAgentTab(boundTaskId)
              }
              onDismiss={actions.dismiss}
              replyDraft={record.draft}
              setReplyDraft={actions.setDraft}
              onReply={() => void actions.sendFollowUp()}
              onReplyEscape={actions.escapeToEditor}
              replyDisabled={isSending}
              workspacePath={workspacePath}
            />
          )}

          {phase === "error" && (
            <ErrorState
              message={turn?.error}
              onRetry={actions.retry}
              onEdit={actions.editPrompt}
              onDismiss={actions.dismiss}
              replyDraft={record.draft}
              setReplyDraft={actions.setDraft}
              onReply={() => void actions.sendFollowUp()}
              onReplyEscape={actions.escapeToEditor}
              replyDisabled={isSending}
              workspacePath={workspacePath}
            />
          )}
        </div>
      </AnimatedHeight>
    </div>
  );
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
/**
 * Everything the face needs, assembled from the store, the collections and
 * the action hooks. Splitting it out keeps the component itself a container
 * in the literal sense — one hook call and one element — and gives the
 * widget's wiring a name of its own.
 */
function usePromptBlobModel(placement: PromptBlobPlacement) {
  const { blobId, workspacePath, documentPath, editor, getPos } = placement;
  const host = usePromptWidgetHost();
  const record = useSyncExternalStore(
    useCallback((cb) => subscribePromptBlob(blobId, cb), [blobId]),
    () => getPromptBlob(blobId),
  );
  const { boundTurnId, boundTaskId } = record;
  const composerRef = useRef<PromptEditorHandle>(null);

  const { label: harnessLabel } = host.useDefaultHarness();
  const { isSending, confirmTrust, cancelAndRestore, ...actions } =
    usePromptBlobActions({
      blobId,
      workspacePath,
      documentPath,
      editor,
      getPos,
      summoned: placement.summoned ?? false,
      removeNode: placement.removeNode,
      onSessionBound: placement.onSessionBound,
      composerRef,
    });

  const { turn, task, sortedEntries, taskTurns, phase } = usePromptBlobRound({
    boundTurnId,
    boundTaskId,
    isSending,
  });

  useInFlightEscape({ blobId, phase, boundTurnId, cancelAndRestore });
  useStaleTurnReset({ blobId, boundTurnId, isSending, hasTurn: Boolean(turn) });
  const { escapeToEditor } = usePromptBlobFocus({
    blobId,
    editor,
    documentPath,
    getPos,
    composerRef,
  });

  const display = usePromptBlobDisplay({
    phase,
    sortedEntries,
    taskTurns,
    boundTurnId,
    workspacePath,
  });

  // One click from any bound phase to the session's full transcript
  // (MET-104) — the done face has its own copy of this in DoneState.
  const openBoundChat = boundTaskId
    ? () => host.openAgentTab(boundTaskId)
    : undefined;

  return {
    phase,
    record,
    turn,
    task,
    boundTaskId,
    workspacePath,
    trustName: harnessLabel,
    confirmTrust,
    isSending,
    display,
    composerRef,
    actions: {
      ...actions,
      escapeToEditor,
      openBoundChat,
      openFile: host.openFile,
      openAgentTab: host.openAgentTab,
    },
  };
}

export const PromptBlob = memo(function PromptBlob(
  placement: PromptBlobPlacement,
) {
  return <PromptBlobFace {...usePromptBlobModel(placement)} />;
});

/**
 * The shared first half of Stop and Escape-cancel: resolve the widget's
 * bound round, and when it's still queued withdraw it (which returns the
 * prompt text to the composing face — not an empty box, MET-94). Returns
 * the bound task for the caller's running-turn handling, or null when
 * there was nothing left to act on (unbound, or withdrawn here).
 */
function withdrawIfQueued(
  host: PromptWidgetHost,
  blobId: string,
  restorePromptToDraft: () => void,
): { taskId: string } | null {
  const { boundTaskId, boundTurnId } = getPromptBlob(blobId);
  if (!boundTaskId || !boundTurnId) return null;
  if (host.getTurnStatus(boundTurnId) === "queued") {
    host.removeQueuedPrompt(boundTaskId, boundTurnId);
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
  onSessionBound,
}: {
  blobId: string;
  workspacePath: string;
  documentPath: string;
  editor: Editor;
  getPos?: () => number | undefined;
  onSessionBound?: (taskId: string) => void;
}) {
  const { t } = useTranslation();
  const host = usePromptWidgetHost();
  const trust = host.useTrust(workspacePath);
  const [isSending, setIsSending] = useState(false);
  const [confirmTrust, setConfirmTrust] = useState(false);

  // The one prompt dispatch both send paths share: they differ only in
  // which task they target and whether the rebind captures it. The
  // widget-context facts are read fresh on every call — a reply may follow
  // a round that filled the doc or moved the node.
  const dispatchPrompt = useCallback(
    (taskId: string, text: string) => {
      const doc = editor.state.doc;
      return host.dispatchPrompt({
        taskId,
        text,
        workspacePath,
        target: widgetPromptTarget({
          documentPath,
          workspacePath,
          pos: getPos?.(),
          docContentSize: doc.content.size,
          isDocEmpty: !docHasRealContent(doc),
          toRelativePath: host.toRelativePath,
        }),
      }).turnId;
    },
    [host, documentPath, workspacePath, editor, getPos],
  );

  const send = useCallback(async () => {
    const text = getPromptBlob(blobId).draft.trim();
    if (!text || isSending) return;
    if (!host.ensureRuntime()) return;
    if (!trust.isTrusted && !confirmTrust) {
      setConfirmTrust(true);
      return;
    }
    if (confirmTrust) {
      trust.grant();
      setConfirmTrust(false);
    }
    setIsSending(true);
    try {
      const taskId = await resolvePromptTarget(host, blobId, workspacePath);
      const turnId = dispatchPrompt(taskId, text);
      updatePromptBlob(blobId, {
        boundTurnId: turnId,
        boundTaskId: taskId,
        lastSentPrompt: text,
        draft: "",
      });
      // The widget is now part of the document's meaning, not just its UI:
      // record the session on the node so the next save writes its marker
      // (MET-163) and an agent write mid-round can't take it away.
      onSessionBound?.(taskId);
    } catch (error) {
      console.error("Prompt blob send failed:", error);
    } finally {
      setIsSending(false);
    }
  }, [
    host,
    blobId,
    isSending,
    trust,
    confirmTrust,
    workspacePath,
    dispatchPrompt,
    onSessionBound,
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
    if (!host.ensureRuntime()) return;
    // dispatchPrompt is infallible by contract: a missing task mints a
    // turnId with no row, and binding to it would trip the stale-turn reset
    // — silently wiping this reply. Check first; on a dead task keep the
    // draft and fall back to composing (re-send starts a fresh session).
    // Reachable covers a session that is merely asleep: a widget restored
    // from the document (MET-163) has no runtime until this prompt revives
    // it via session/load, which is exactly the point of persisting it.
    if (!(await host.isTaskReachable(taskId))) {
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
  }, [host, blobId, isSending, dispatchPrompt, t]);

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
  onSessionBound,
  composerRef,
}: PromptBlobPlacement & {
  summoned: boolean;
  composerRef: React.RefObject<PromptEditorHandle>;
}) {
  const host = usePromptWidgetHost();
  const { isSending, confirmTrust, send, sendFollowUp } = usePromptSendActions({
    blobId,
    workspacePath,
    documentPath,
    editor,
    getPos,
    onSessionBound,
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
    requestAnimationFrame(() => composerRef.current?.focus());
  }, [blobId, composerRef]);

  // Edit: pull the sent prompt back into the composer. A queued turn is
  // withdrawn; a running/finished one keeps going — re-send is a new turn.
  const editPrompt = useCallback(() => {
    const { boundTaskId, boundTurnId } = getPromptBlob(blobId);
    if (
      boundTaskId &&
      boundTurnId &&
      host.getTurnStatus(boundTurnId) === "queued"
    ) {
      host.removeQueuedPrompt(boundTaskId, boundTurnId);
    }
    restorePromptToDraft();
  }, [host, blobId, restorePromptToDraft]);

  // Retry: pull the failed prompt back into the composer and immediately
  // re-send it, no re-typing required. editPrompt writes the restored draft
  // into the module-level store synchronously, so send() (which reads the
  // draft at call time) sees it right away.
  const retry = useCallback(() => {
    editPrompt();
    void send();
  }, [editPrompt, send]);

  const stop = useCallback(() => {
    const running = withdrawIfQueued(host, blobId, restorePromptToDraft);
    if (running) host.cancelTask(running.taskId);
  }, [host, blobId, restorePromptToDraft]);

  // Escape while in flight (MET-94): cancel the turn and — when the agent
  // hadn't responded yet — return to the composing face with the prompt
  // restored, its round forgotten (the restored prompt must not also
  // linger in the history it was pulled out of). Once a response exists
  // the round is real: forgetting it would hide context the session still
  // holds, so Escape then degrades to Stop (stay bound, "Stopped" done
  // face, no restore — the prompt is right there in the round). A queued
  // turn is withdrawn, which already deletes its rows.
  const cancelAndRestore = useCallback(() => {
    const running = withdrawIfQueued(host, blobId, restorePromptToDraft);
    if (running) {
      void host.cancelTurnAndForget(running.taskId).then((forgot) => {
        if (forgot) restorePromptToDraft();
      });
    }
  }, [host, blobId, restorePromptToDraft]);

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

  // Picking a session on a widget that already belongs to one re-targets
  // THIS widget (and its document marker), rather than only moving the
  // workspace's shared session — otherwise the icon would name one session
  // and the prompt would go to another.
  const rebindSession = useCallback(
    (taskId: string) => {
      host.adoptSession(workspacePath, taskId);
      updatePromptBlob(blobId, { boundTaskId: taskId, boundTurnId: null });
      onSessionBound?.(taskId);
    },
    [host, blobId, workspacePath, onSessionBound],
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
    rebindSession,
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
  boundTaskId,
  onSelectSession,
  composerRef,
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
  boundTaskId?: string | null;
  onSelectSession?: (taskId: string) => void;
  composerRef: React.RefObject<PromptEditorHandle>;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col">
      <div className="flex items-start gap-1.5 px-1.5 py-1">
        <SessionControl
          workspacePath={workspacePath}
          boundTaskId={boundTaskId}
          onSelectSession={onSelectSession}
        />
        <PromptEditor
          ref={composerRef}
          workspacePath={workspacePath}
          value={draft}
          onChange={setDraft}
          onKeyDown={(event) => {
            const action = deriveComposerKeyAction({
              key: event.key,
              shiftKey: event.shiftKey,
              draftEmpty: draft.trim().length === 0,
              canRevert: onRevert !== undefined,
              inFlight: false,
            });
            if (action.type === "none") return false;
            if (action.type === "send") onSend();
            else if (action.type === "revert") onRevert?.();
            else if (action.type === "backspaceDismiss") onBackspaceDismiss?.();
            else onEscape();
            return true;
          }}
          placeholder={t("promptBlobPlaceholder")}
          className="min-h-[1.75rem] min-w-0 flex-1 pt-1 pb-1.5 text-sm"
        />
      </div>
      {confirmTrust && (
        <span className="px-3 pb-1.5 text-[0.6875rem] text-amber-600 dark:text-amber-400">
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
function SessionControl({
  workspacePath,
  boundTaskId,
  onSelectSession,
}: {
  workspacePath: string;
  /** The session this widget is already bound to (a restored widget, MET-163)
   *  — the icon must name where the prompt will actually go, which is this
   *  task rather than the workspace's shared session. */
  boundTaskId?: string | null;
  /** Re-target a bound widget. Absent for an unbound one, whose selection
   *  just moves the shared session as it always did. */
  onSelectSession?: (taskId: string) => void;
}) {
  const { t } = useTranslation();
  const host = usePromptWidgetHost();
  const defaultHarness = host.useDefaultHarness();
  // Already filtered to live sessions and ordered newest-first by the host.
  const sessions = host.useSessionList(workspacePath);
  const [open, setOpen] = useState(false);

  const peekedTaskId = boundTaskId ?? host.peekSession(workspacePath);
  // The trigger's logo names where the prompt would go. The session it points
  // at is in the list whenever it is live, so no second lookup is needed.
  const triggerHarnessId =
    sessions.find((session) => session.taskId === peekedTaskId)?.harnessId ??
    defaultHarness.id;

  const recentSessions = sessions.slice(0, 5);

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
            {recentSessions.map((session) => (
              <DropdownMenuItem
                key={session.taskId}
                className="cursor-pointer gap-2 text-xs"
                onSelect={() =>
                  onSelectSession
                    ? onSelectSession(session.taskId)
                    : host.adoptSession(workspacePath, session.taskId)
                }
              >
                {session.taskId === peekedTaskId ? (
                  <Check className="size-3 shrink-0" />
                ) : (
                  <HarnessLogo
                    harnessId={session.harnessId}
                    className="size-3"
                  />
                )}
                <span className="min-w-0 flex-1 truncate">{session.title}</span>
                <span className="shrink-0 text-[0.6875rem] text-muted-foreground">
                  {session.description}
                </span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem
          className="cursor-pointer gap-2 text-xs"
          onSelect={() => host.dropSession(workspacePath)}
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
  onOpenChat,
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
  /** Jump to the bound session's chat (MET-104) — present in every bound
   *  phase, so a pending prompt is one click from its full transcript. */
  onOpenChat?: () => void;
}) {
  const { t } = useTranslation();
  const secondLine = teaser ?? prompt;
  return (
    <div className="flex items-center gap-2 px-2.5 py-1.5">
      {shimmer && (
        <OrbLoader state="connecting" className="text-muted-foreground" />
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
          <div className="truncate text-[0.6875rem] text-muted-foreground">
            {secondLine}
          </div>
        )}
      </div>
      <button
        type="button"
        title={t("promptBlobOpenChat")}
        aria-label={t("promptBlobOpenChat")}
        disabled={!onOpenChat}
        className={cn(
          "shrink-0 rounded p-1 text-muted-foreground transition-colors",
          onOpenChat
            ? "cursor-pointer hover:bg-accent hover:text-foreground"
            : "invisible",
        )}
        onClick={onOpenChat}
      >
        <MessageSquare className="size-3.5" />
      </button>
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
  workspacePath,
}: {
  draft: string;
  setDraft: (value: string) => void;
  onSend: () => void;
  onEscape: () => void;
  disabled: boolean;
  workspacePath: string;
}) {
  const { t } = useTranslation();
  return (
    <PromptEditor
      workspacePath={workspacePath}
      value={draft}
      onChange={setDraft}
      disabled={disabled}
      onKeyDown={(event) => {
        const action = deriveComposerKeyAction({
          key: event.key,
          shiftKey: event.shiftKey,
          draftEmpty: draft.trim().length === 0,
          canRevert: false,
          inFlight: false,
        });
        if (action.type === "none") return false;
        if (action.type === "send") onSend();
        else if (action.type === "escape") onEscape();
        return true;
      }}
      placeholder={t("promptBlobReply")}
      className="mt-1 min-h-[1.5rem] w-full border-t border-border/60 px-0.5 pt-1.5 text-xs"
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

/** The documents a finished turn wrote to, each a shortcut back into the
 *  file. Its own component so the done face stays readable — that face is
 *  already the branchiest part of the widget. */
function TouchedFileChips({
  paths,
  onOpenFile,
}: {
  paths: string[];
  onOpenFile: (path: string) => void;
}) {
  if (paths.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {paths.map((path) => (
        <button
          key={path}
          type="button"
          className="flex cursor-pointer items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[0.6875rem] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          onClick={() => onOpenFile(path)}
        >
          <FileText className="size-3" />
          {basename(path)}
        </button>
      ))}
    </div>
  );
}

/** Done: the widget's single resting face — the full response body,
 *  rendered as markdown and visible immediately (MET-133); the heading line
 *  above it doubles as the collapse toggle back to a one-line summary. The
 *  content prefers the `widget_respond` response and falls back to the
 *  turn's last assistant text, so even a harness that never calls the tool
 *  leaves something readable behind.
 *  No Edit here: Reply continues the session, ✕ dismisses; rewriting from
 *  scratch is what a fresh widget is for.
 *  Exported for tests only — mounting the whole PromptBlob needs Tiptap and
 *  live collections; the done face is testable standalone. */
export function DoneState({
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
  workspacePath,
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
  workspacePath: string;
}) {
  const { t } = useTranslation();
  const { Markdown } = usePromptWidgetHost().slots;
  // Expanded by default (MET-133): the response body IS the outcome — the
  // collapsed one-liner is the opt-in resting face, not the landing state.
  // Component-local on purpose; a dock remount resets to expanded, which is
  // the desired default anyway.
  const [expanded, setExpanded] = useState(true);
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
        <Markdown
          text={body}
          className={cn(
            "select-text text-xs leading-relaxed",
            // Scroll cap: brevity is steered on the agent side (the
            // widget_respond directive), but a runaway response must scroll
            // inside the widget, not swallow the document.
            "max-h-80 overflow-y-auto",
            // Issue text mirrors ErrorState's uniform tinted text, in amber
            // — the card border (blobCardClass) carries the rest; no filled
            // callout box.
            isIssue
              ? "text-amber-600 dark:text-amber-400"
              : "text-foreground/80",
          )}
        />
      )}
      <TouchedFileChips paths={touchedFiles} onOpenFile={onOpenFile} />
      <ReplyRow
        draft={replyDraft}
        setDraft={setReplyDraft}
        onSend={onReply}
        onEscape={onReplyEscape}
        disabled={replyDisabled}
        workspacePath={workspacePath}
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
  workspacePath,
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
  workspacePath: string;
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
        workspacePath={workspacePath}
      />
    </div>
  );
}
