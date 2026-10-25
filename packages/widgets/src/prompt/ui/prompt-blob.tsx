import {
  type CSSProperties,
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
  CornerDownLeft,
  FileText,
  MessageSquare,
  Pencil,
  RotateCw,
  Square,
  TextQuote,
  X,
} from "lucide-react";
import { toast } from "sonner";
import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { Button } from "@notefig/ui/button";
import { Checkbox } from "@notefig/ui/checkbox";
import { OrbLoader } from "@notefig/ui/orb-loader";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@notefig/ui/dropdown-menu";
import { cn } from "@notefig/ui/utils";
import {
  sortEntriesChronologically,
  type AgentEntry,
  type AgentTaskRow,
  type AgentTurn,
  type WidgetResponse,
} from "@notefig/shared/agent";
import { draftToNode, readDraftNode } from "../composer/draft-text";
import { mentionPopupHasResults } from "../composer/mention-bridge";
import { hostIsMention } from "../composer/mention-suggestion";
import { registerComposerKeyHandler } from "../composer/key-bridge";
import { WidgetResponseView } from "./widget-response-view";
import { usePromptChangeCounts, type PromptReview } from "../change-store";
import {
  usePromptChangeNavigation,
  type PromptChangeNavigation,
} from "../change-navigator";
import { usePromptWidgetHost } from "../host-context";
import type { PromptWidgetHost } from "../host";
import {
  docHasRealContent,
  findPromptNodePos,
  promptDraftRange,
  selectionDraft,
} from "../doc-helpers";
import type { PromptReference } from "../doc-helpers";
import { basename } from "../basename";
import type { PromptWidget, PromptWidgetsApi } from "../widgets-service";
import {
  capabilitiesOf,
  phaseOf,
  type WidgetCapabilities,
} from "../machine";
import {
  deriveActiveToolLine,
  deriveLatestAssistantLine,
  deriveQueuePosition,
  deriveComposerKeyAction,
  type ComposerKeyAction,
  widgetPromptTarget,
  blobCardClass,
  referenceRemovalArmed,
  takesTyping,
  composeChoiceAnswer,
  deriveChoiceKey,
  type BlobPhase,
  type RoundOutcome,
} from "../state";

/** What the face reads off a widget's record: the prompt it last sent. */
export type PromptBlobRecord = Pick<PromptWidget, "lastSentPrompt">;

/**
 * Where this widget instance sits in the document, and the three ways it may
 * write back to its node. Handed down by the node view — distinct from
 * PromptWidgetHost, which is how the widget reaches the application.
 */
interface PromptBlobPlacement {
  /** Every prompt widget's state; this one is `blobId`'s. */
  prompts: PromptWidgetsApi;
  /** This widget instance's identity (the node's blobId attr) — the
   *  service key. Documents can hold several widgets; the path is not
   *  identity. */
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
  /** The selection this widget was summoned over (the node's reference
   *  attr), frozen at capture. Redirects the summon's dismiss gestures to
   *  plain removal — there is no "/" or paragraph to restore — and renders
   *  as the quoted line above the composer. */
  reference?: PromptReference | null;
  /** Drop the captured reference from the node (the chip's ✕): the widget
   *  becomes a regular one — future sends carry no reference and the
   *  summon dismiss gestures disarm. Provided by the node view. */
  clearReference?: () => void;
  /** Remove this widget's document node; insertSlash leaves a literal "/"
   *  in its place, restoreParagraph leaves a plain empty paragraph (the
   *  Backspace-dismiss path), restoreCaret deletes outright and lands the
   *  caret at the end of the block above (the selection-summon dismiss).
   *  Provided by the node view (getPos/deleteNode). */
  removeNode?: (options?: {
    insertSlash?: boolean;
    restoreParagraph?: boolean;
    restoreCaret?: boolean;
  }) => void;
  /** The draft's current text, read off the node by the view. */
  draft?: string;
  /** The widget's content hole — the draft the user types, as document
   *  content. ProseMirror requires a node's contentDOM to stay mounted, so
   *  this element is rendered exactly once and never moves between parents;
   *  the phase decides how the row around it is dressed, not whether it is
   *  there. */
  draftSlot?: React.ReactNode;
}

/**
 * Reading and writing a widget's draft, which lives in the document rather
 * than in a store: the draft is `aiPrompt > promptDraft`, so "set the
 * composer text" is a ranged replace and "focus the composer" is a
 * selection.
 *
 * Every read goes through the live document at call time, the same
 * discipline the rest of these actions already follow — a widget can be
 * moved, adopted, or re-parsed between a render and a callback firing.
 */
function useDraftIO(
  prompts: PromptWidgetsApi,
  editor: Editor,
  blobId: string,
  workspacePath: string,
) {
  const host = usePromptWidgetHost();
  return useMemo(() => {
    const range = () => promptDraftRange(editor.state.doc, blobId);
    const read = () => {
      const found = range();
      return found ? readDraftNode(found.node) : "";
    };
    /** Replace the draft's text, caret at the end. Not autosave-exempt and
     *  not history-exempt: it is an ordinary document edit, which is the
     *  whole point of the draft living here. */
    const write = (text: string) => {
      const found = range();
      if (!found) return;
      const taskId = prompts.get(blobId).boundTaskId;
      const isPath = hostIsMention(host, { workspacePath, taskId });
      const tr = editor.state.tr.replaceWith(
        found.from,
        found.to,
        editor.state.schema.nodeFromJSON(draftToNode(isPath, text)).content,
      );
      const after = promptDraftRange(tr.doc, blobId);
      if (after) tr.setSelection(TextSelection.create(tr.doc, after.to));
      editor.view.dispatch(tr);
    };
    /** True while the caret is in THIS widget's draft — the guard the key
     *  map and the chrome's active styling share. */
    const holdsCaret = () => selectionDraft(editor.state)?.blobId === blobId;
    /** Caret to the end of the draft and focus to the document, without
     *  moving the viewport: the widget is already in front of the user. */
    const focus = () => {
      const found = range();
      if (!found) return;
      editor
        .chain()
        .focus(undefined, { scrollIntoView: false })
        .setTextSelection(found.to)
        .run();
    };
    /** Caret out of the draft, to the text after the widget, when it is
     *  there — focus is left where it is. */
    const leave = () => {
      if (!holdsCaret()) return;
      const pos = findPromptNodePos(editor.state.doc, blobId);
      const node = pos === null ? null : editor.state.doc.nodeAt(pos);
      if (pos === null || !node) return;
      const $after = editor.state.doc.resolve(pos + node.nodeSize);
      editor.view.dispatch(
        editor.state.tr.setSelection(TextSelection.near($after, 1)),
      );
    };
    return { read, write, holdsCaret, focus, leave };
  }, [prompts, editor, blobId, host, workspacePath]);
}

export type DraftIO = ReturnType<typeof useDraftIO>;

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
  bound: string | null,
  workspacePath: string,
): Promise<string> {
  if (bound && (await host.isTaskReachable(bound))) return bound;
  return host.startOrGetSharedSession(workspacePath);
}

/**
 * The live rows behind one widget's bound round, for what the card shows
 * from the transcript. Sentinel ids keep the queries unconditional: an
 * unbound widget still runs them, matching nothing. The phase is not
 * derived here — it is the service's state.
 */
function usePromptBlobRound({
  boundTurnId,
  boundTaskId,
}: {
  boundTurnId: string | null;
  boundTaskId: string | null;
}) {
  const host = usePromptWidgetHost();
  const { turn, task, entries, taskTurns } = host.useRound({
    turnId: boundTurnId,
    taskId: boundTaskId,
  });
  const sortedEntries = useMemo(
    () => sortEntriesChronologically(entries),
    [entries],
  );
  return { turn, task, sortedEntries, taskTurns };
}

/**
 * Everything the card shows besides its state. A settled round's face — the
 * answer, the summary, the error, the files it touched — is its stored
 * outcome (MET-251), the same live or after a restart. Only what a working
 * agent is doing right now comes from the transcript: the live tool line,
 * the assistant teaser, the queue position.
 */
function usePromptBlobDisplay({
  review,
  blobId,
  editor,
  phase,
  widget,
  sortedEntries,
  taskTurns,
}: {
  review: PromptReview;
  blobId: string;
  editor: Editor;
  phase: BlobPhase;
  widget: PromptWidget;
  sortedEntries: AgentEntry[];
  taskTurns: AgentTurn[];
}): PromptBlobDisplay {
  const running = phase === "running";
  const rawActiveToolLine = running ? deriveActiveToolLine(sortedEntries) : null;
  const activeToolLine = useDebouncedActiveToolLine(rawActiveToolLine);
  return {
    ...outcomeDisplay(
      widget.outcome,
      widget.state.name === "settled" && widget.state.outcome === "cancelled",
    ),
    activeToolLine,
    // The live teaser under the status line.
    assistantTeaser: running ? deriveLatestAssistantLine(sortedEntries) : null,
    queueAhead: queuePosition(phase, taskTurns, widget.boundTurnId),
    changeCounts: usePromptChangeCounts(review, blobId),
    changes: usePromptChangeNavigation(review, blobId, editor),
  };
}

/** A settled round's face: what the round left behind. */
export type OutcomeDisplay = {
  touchedFiles: string[];
  widgetResponse: WidgetResponse | null;
  /** The last assistant line: the fallback when there is no answer. */
  summary: string | null;
  /** The round was stopped. */
  cancelled: boolean;
  /** Why the round failed. */
  errorMessage: string | null;
};

/** The one way an outcome becomes the settled face — the app's widgets
 *  from their recorded rounds, the site's demo from its scripted one. */
export function outcomeDisplay(
  outcome: RoundOutcome | null,
  cancelled: boolean,
): OutcomeDisplay {
  return {
    touchedFiles: outcome?.touchedFiles ?? [],
    widgetResponse: outcome?.response ?? null,
    summary: outcome?.summary ?? null,
    cancelled,
    errorMessage: outcome?.error ?? null,
  };
}



function queuePosition(
  phase: BlobPhase,
  taskTurns: AgentTurn[],
  boundTurnId: string | null,
): number {
  return phase === "queued" && boundTurnId
    ? deriveQueuePosition(taskTurns, boundTurnId)
    : 0;
}

/**
 * Escape anywhere stops this widget's agent (MET-248). A global hotkey, not
 * a card-level keydown: once a prompt is sent the caret is usually back in
 * the document, where no element inside the widget hears the key. Among the
 * mounted widgets (the dock unmounts unselected tabs; split panes each
 * mount theirs) the one holding the newest turn acts.
 */
function useInFlightEscape({
  prompts,
  blobId,
  stoppable,
  stop,
}: {
  prompts: PromptWidgetsApi;
  blobId: string;
  stoppable: boolean;
  stop: () => void;
}) {
  useEffect(() => prompts.claimEscape(blobId), [prompts, blobId]);
  useHotkey(
    "Escape",
    (event) => {
      // A layer that consumed the key (dialog/menu dismissal) wins.
      if (event.defaultPrevented) return;
      if (!prompts.isNewestStoppable(blobId)) return;
      stop();
      // Consumed: the key did its one job, nothing behind it acts too.
      event.preventDefault();
    },
    // 'allow': several widgets can legitimately hold this registration;
    // the newest turn decides which one acts. preventDefault: false — the
    // library's default calls preventDefault() BEFORE this callback, which
    // the defaultPrevented check above would then read as another layer
    // having consumed the key, and the widget would never stop.
    { enabled: stoppable, conflictBehavior: "allow", preventDefault: false },
  );
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
  draftIO,
}: {
  blobId: string;
  editor: Editor;
  documentPath: string;
  getPos?: () => number | undefined;
  draftIO: DraftIO;
}) {
  const host = usePromptWidgetHost();

  // The keeper's "active by default on new documents" rule. `onCreate` put
  // the caret in this widget's draft before the node view mounted, which is
  // why the claim is made from here rather than from the tab layout's own
  // mount intent — by then there was no widget to notice. What is left is
  // the focus half. It is an AMBIENT claim: a document can open under the
  // user's hands for reasons that are not theirs (a project landing in its
  // scratchpad while they rename a file in the tree), and yanking focus
  // out of a text entry they are typing in is never right. The arbiter
  // keeps the intent alive until the entry closes — the create-file field
  // is gone by the time its file's document mounts — so the composer still
  // ends up focused on a genuinely new document.
  const claimed = useRef(false);
  useEffect(() => {
    if (claimed.current) return;
    claimed.current = true;
    if (docHasRealContent(editor.state.doc)) return;
    // Not when the doc merely BECAME empty (select-all + delete): the
    // keeper reinsert remounts this widget while the user's caret is in the
    // editor, and it must stay there.
    if (!draftIO.holdsCaret() || editor.view.hasFocus()) return;
    host.focusDocument(documentPath, {
      reason: "empty-doc-prompt",
      steal: false,
    });
  }, [host, documentPath, editor, draftIO]);

  // Escape back to the document: the caret is already in this editor, so
  // "hand focus back" is just a selection move to the position after the
  // widget — no arbiter intent, no caret-placement hint, nothing to race.
  // That collapse is the point of the draft being document content.
  return useCallback(() => {
    const pos = getPos?.() ?? findPromptNodePos(editor.state.doc, blobId);
    if (pos === null || pos === undefined) return;
    const node = editor.state.doc.nodeAt(pos);
    if (!node) return;
    // TextSelection.near, not the raw boundary position: pos + nodeSize is a
    // doc-level gap between nodes, and a TextSelection created there cannot
    // be represented by a DOM caret — the browser keeps typing into the
    // draft. `near` snaps forward into the next textblock.
    const $after = editor.state.doc.resolve(pos + node.nodeSize);
    editor
      .chain()
      .focus(undefined, { scrollIntoView: false })
      .setTextSelection(TextSelection.near($after, 1).from)
      .run();
  }, [editor, blobId, getPos]);
}

/**
 * The composer key map, registered with the extension's key bridge.
 *
 * `deriveComposerKeyAction` is unchanged — only its delivery moved. It
 * cannot be a DOM listener on the widget's own element: key events in a
 * contenteditable target the editing host — the document's `.ProseMirror`
 * root, an ANCESTOR of the card — so a bubbling listener here never fires.
 * The extension's `addKeyboardShortcuts` (node-view.tsx) is where
 * ProseMirror actually routes keys for a caret inside the draft; it resolves
 * the draft under the selection and forwards through key-bridge.ts to this
 * handler.
 *
 * One guard: an open mention popup owns Enter/Escape — but only while it
 * has rows to offer. "Caret in THIS draft" is the extension's dispatch
 * condition, so it needs no re-check here.
 */
function useComposerKeys({
  blobId,
  documentPath,
  draftIO,
  capabilities,
  composing,
  actions,
  choiceKey,
}: {
  blobId: string;
  documentPath: string;
  draftIO: DraftIO;
  capabilities: WidgetCapabilities;
  /** A fresh prompt, as opposed to a reply under a settled round. */
  composing: boolean;
  actions: Pick<
    PromptBlobFaceActions,
    | "send"
    | "sendFollowUp"
    | "stop"
    | "escapeToEditor"
    | "revertToSlash"
    | "backspaceDismiss"
  >;
  /** A choice question's options take the keys first (useChoiceAnswer). */
  choiceKey: ChoiceAnswer["onKey"];
}) {
  const latest = useRef({ draftIO, capabilities, composing, actions, choiceKey });
  latest.current = { draftIO, capabilities, composing, actions, choiceKey };

  useEffect(
    () =>
      registerComposerKeyHandler(blobId, (input) => {
        if (mentionPopupHasResults(documentPath)) return false;
        const { draftIO: io, capabilities: can, composing: fresh, actions: live } =
          latest.current;
        // Read the draft off the live document, per useDraftIO's own
        // discipline — the render snapshot can trail the document, and a
        // stale "empty" here would dismiss the widget on the very keypress
        // meant to delete the last character.
        const text = io.read();
        const choice = latest.current.choiceKey(input.key, text);
        if (choice !== null) return choice;
        const action = deriveComposerKeyAction({
          key: input.key,
          shiftKey: input.shiftKey,
          draftEmpty: text.trim().length === 0,
          // Reverting to "/" belongs to a summoned widget that has never
          // been sent; Backspace-dismiss to a fresh composer. A reply row
          // (a widget showing its round) gets neither, and nothing while
          // the agent works.
          canRevert: can.escape === "revert" && live.revertToSlash !== undefined,
          canDismiss: fresh && live.backspaceDismiss !== undefined,
          inFlight: can.escape === "stop",
        });
        if (action.type === "none") return false;
        runComposerKey(action, can.fieldEditable && (fresh ? live.send : live.sendFollowUp), live);
        return true;
      }),
    [blobId, documentPath],
  );
}

/** Carry out a composer key. `send` is how this widget sends now, false
 *  when its field takes nothing. */
function runComposerKey(
  action: Exclude<ComposerKeyAction, { type: "none" }>,
  send: false | (() => Promise<void> | void),
  actions: Pick<
    PromptBlobFaceActions,
    "stop" | "revertToSlash" | "backspaceDismiss" | "escapeToEditor"
  >,
): void {
  switch (action.type) {
    case "send":
      if (send) void send();
      return;
    case "cancel":
      return actions.stop();
    case "revert":
      return actions.revertToSlash?.();
    case "backspaceDismiss":
      return actions.backspaceDismiss?.();
    case "escape":
      return actions.escapeToEditor();
  }
}

/** The options a choice question offers, and what the user has picked. */
export type ChoiceDisplay = {
  options: string[];
  multiple: boolean;
  picked: string[];
  /** The option the keys are on; null while they are in the field. */
  focused: number | null;
};

/** What the face renders besides its state. */
interface PromptBlobDisplay extends OutcomeDisplay {
  /** The open choice question's options; null when none is asked. */
  choice?: ChoiceDisplay | null;
  activeToolLine: string | null;
  assistantTeaser: string | null;
  queueAhead: number;
  /** Changes this widget's round left marked, per document. */
  changeCounts: ReadonlyMap<string, number>;
  /** Review of the round's changes in this document. */
  changes: PromptChangeNavigation;
}

/** Everything the face can do. Grouped so the container hands over one
 *  object instead of a dozen callbacks. */
interface PromptBlobFaceActions {
  send: () => Promise<void> | void;
  sendFollowUp: () => Promise<void> | void;
  /** A choice option clicked: a single choice sends it, a multiple one
   *  toggles it. */
  pickOption?: (option: string) => void;
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
  draft,
  task,
  boundTaskId,
  display,
  actions,
}: {
  phase: BlobPhase;
  record: PromptBlobRecord;
  /** The live draft, still in the document while the send is in flight. */
  draft: string;
  task: AgentTaskRow | undefined;
  boundTaskId: string | null;
  display: PromptBlobDisplay;
  actions: PromptBlobFaceActions;
}) {
  const { t } = useTranslation();
  const { slots } = usePromptWidgetHost();

  if (phase === "sending") return <StatusRow shimmer prompt={draft} />;

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
      <RunningFace
        phase={phase}
        record={record}
        boundTaskId={boundTaskId}
        display={display}
        actions={actions}
      />
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

/** The in-flight card: the shimmer status row, and — while the agent waits
 *  on a permission — the permission card under it. */
function RunningFace({
  phase,
  record,
  boundTaskId,
  display,
  actions,
}: {
  phase: BlobPhase;
  record: PromptBlobRecord;
  boundTaskId: string | null;
  display: PromptBlobDisplay;
  actions: PromptBlobFaceActions;
}) {
  const { t } = useTranslation();
  const { slots } = usePromptWidgetHost();
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

/**
 * The widget's face: given a phase and the state behind it, which card to
 * show. Purely presentational — every hook, subscription and side effect
 * lives in PromptBlob, so this is the part that can be rendered in a test
 * with plain objects.
 */
/**
 * The widget claims its pointer events wholesale: ProseMirror must not turn
 * clicks on its controls into node selections, and the editor's
 * gutter-click focus handler must not grab them either. The draft is the
 * exception — it is document text, and a click there has to place a caret
 * like any other.
 */
function claimWidgetPointerEvents(event: React.MouseEvent): void {
  if (
    event.target instanceof Element &&
    event.target.closest("[data-prompt-draft]")
  ) {
    return;
  }
  event.stopPropagation();
}

export function PromptBlobFace({
  phase,
  record,
  task,
  boundTaskId,
  workspacePath,
  documentPath,
  trustName,
  confirmTrust,
  isSending,
  display,
  draft,
  draftIO,
  draftSlot,
  reference,
  clearReference,
  actions,
  rules,
}: {
  phase: BlobPhase;
  record: PromptBlobRecord;
  task: AgentTaskRow | undefined;
  boundTaskId: string | null;
  workspacePath: string;
  documentPath: string;
  trustName: string;
  confirmTrust: boolean;
  isSending: boolean;
  display: PromptBlobDisplay;
  draft: string;
  draftIO: DraftIO;
  draftSlot?: React.ReactNode;
  reference?: PromptReference | null;
  clearReference?: () => void;
  actions: PromptBlobFaceActions;
  /** What the widget allows now. Absent for a face with no widget behind
   *  it (the marketing demo, tests): read off the phase. */
  rules?: FaceRules;
}) {
  const response = display.widgetResponse?.kind;
  return (
    <FaceFrame
      phase={phase}
      response={response}
      refusedAt={rules?.removalRefusedAt ?? null}
    >
      <AnimatedHeight>
        <div
          className={cn(
            "rounded-lg border",
            blobCardClass(phase, response === "issue"),
          )}
        >
          {/* Everything above the draft row is chrome, and chrome inside a
              node view must be contentEditable={false} — the same rule
              BlobNodeView follows. It is not cosmetic: without it the whole
              card is part of the document's editing host, so the browser
              spellchecks the agent's transcript, computes visible positions
              through every button, and will happily park a caret in a
              status line. The draft below is the one editable island. */}
          <div contentEditable={false}>
            <ReferenceLine
              reference={reference}
              phase={phase}
              onRemove={clearReference}
            />
            <SentFace
              phase={phase}
              record={record}
              draft={draft}
              task={task}
              boundTaskId={boundTaskId}
              display={display}
              actions={actions}
            />

            <SettledState
              phase={phase}
              display={display}
              boundTaskId={boundTaskId}
              documentPath={documentPath}
              actions={actions}
            />
            <RemovalRefusedHint shown={rules?.removalRefused === true} />
          </div>

          <DraftRow
            phase={phase}
            editable={rules?.fieldEditable}
            draftSlot={draftSlot}
            empty={draft.trim().length === 0}
            confirmTrust={confirmTrust}
            trustName={trustName}
            workspacePath={workspacePath}
            boundTaskId={boundTaskId}
            onSelectSession={actions.rebindSession}
            focusComposer={draftIO.focus}
          />
        </div>
      </AnimatedHeight>
    </FaceFrame>
  );
}

/** What a face's widget allows now. */
interface FaceRules {
  /** The draft takes typing (the widget's `fieldEditable`). */
  fieldEditable: boolean;
  /** A delete was just refused: say how to remove it. */
  removalRefused: boolean;
  /** When the last delete was refused: each one shakes the face. */
  removalRefusedAt: number | null;
}

/** The quoted selection a widget was summoned over, when there is one. */
function ReferenceLine({
  reference,
  phase,
  onRemove,
}: {
  reference: PromptReference | null | undefined;
  phase: BlobPhase;
  onRemove?: () => void;
}) {
  if (!reference) return null;
  return <ReferenceChip text={reference.text} phase={phase} onRemove={onRemove} />;
}

/** The face's outer element: pointer ownership, the inspection hooks, and
 *  the refusal's shake. */
function FaceFrame({
  phase,
  response,
  refusedAt,
  children,
}: {
  phase: BlobPhase;
  response: string | undefined;
  refusedAt: number | null;
  children: React.ReactNode;
}) {
  const frame = useRef<HTMLDivElement>(null);
  useShakeOn(frame, refusedAt);
  return (
    <div
      ref={frame}
      onMouseDown={claimWidgetPointerEvents}
      className="relative w-full"
      // Test/inspection hook: the widget's phase-machine state.
      data-blob-phase={phase}
      data-blob-response={response}
    >
      {children}
    </div>
  );
}

/** A quick shake each time `at` moves on — every refused attempt, not
 *  just the first in a row (a CSS animation keyed to an attribute that's
 *  already set wouldn't replay). Still under reduced motion. */
function useShakeOn(
  element: React.RefObject<HTMLElement | null>,
  at: number | null,
): void {
  useEffect(() => {
    const node = element.current;
    // A refusal from before this mount isn't news.
    if (at === null || !node || Date.now() - at > 500) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    if (typeof node.animate !== "function") return;
    const shake = node.animate(
      [
        { transform: "translateX(0)" },
        { transform: "translateX(-3px)" },
        { transform: "translateX(3px)" },
        { transform: "translateX(0)" },
      ],
      { duration: 150, easing: "ease-in-out" },
    );
    return () => shake.cancel();
  }, [element, at]);
}

/** Why a delete just did nothing. */
function RemovalRefusedHint({ shown }: { shown: boolean }) {
  const { t } = useTranslation();
  if (!shown) return null;
  return (
    <p
      role="status"
      className="px-2.5 pb-1.5 text-[0.6875rem] text-muted-foreground"
    >
      {t("promptBlobStopToRemove")}
    </p>
  );
}

/** The face of a round that has ended: Done and Error are the two resting
 *  cards, and a question is the done card waiting on its answer (the draft
 *  row below takes it). Chosen here so the face itself stays phase-agnostic
 *  layout. */
function SettledState({
  phase,
  display,
  boundTaskId,
  documentPath,
  actions,
}: {
  phase: BlobPhase;
  display: PromptBlobDisplay;
  boundTaskId: string | null;
  documentPath: string;
  actions: PromptBlobFaceActions;
}) {
  if (phase === "done" || phase === "needs-answer") {
    return (
      <DoneState
        choices={
          phase === "needs-answer" && display.choice && actions.pickOption ? (
            <ChoiceOptions
              choice={display.choice}
              onPick={actions.pickOption}
              onSend={() => void actions.sendFollowUp()}
            />
          ) : null
        }
        cancelled={display.cancelled}
        response={display.widgetResponse}
        fallbackText={display.summary}
        touchedFiles={display.touchedFiles}
        documentPath={documentPath}
        changeCounts={display.changeCounts}
        changes={display.changes}
        onOpenFile={(path) => actions.openFile(path)}
        onOpenChat={() => boundTaskId && actions.openAgentTab(boundTaskId)}
        onDismiss={actions.dismiss}
      />
    );
  }
  if (phase === "error") {
    return (
      <ErrorState
        message={display.errorMessage ?? undefined}
        onRetry={actions.retry}
        onEdit={actions.editPrompt}
        onDismiss={actions.dismiss}
      />
    );
  }
  return null;
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
 * State lives in the prompt service (../widgets-service.ts), keyed by the
 * widget's blobId: the dock unmounts unselected tabs, and a running turn
 * must survive that. Turns queue into the shared per-workspace session;
 * each widget watches only its own bound turn.
 */
/** One click from any bound phase to the session's full transcript
 *  (MET-104) — the done face has its own copy of this in DoneState. */
function openBoundChatAction(
  host: PromptWidgetHost,
  boundTaskId: string | null,
): (() => void) | undefined {
  if (!boundTaskId) return undefined;
  return () => host.openAgentTab(boundTaskId);
}

/**
 * Everything the face needs, assembled from the widget's state, the
 * collections and the action hooks. Splitting it out keeps the component
 * itself a container in the literal sense — one hook call and one element —
 * and gives the widget's wiring a name of its own.
 */
function usePromptBlobModel(placement: PromptBlobPlacement) {
  const { prompts, blobId, workspacePath, documentPath, editor, getPos } =
    placement;
  const host = usePromptWidgetHost();
  const widget = useSyncExternalStore(
    useCallback((cb) => prompts.subscribe(blobId, cb), [prompts, blobId]),
    () => prompts.get(blobId),
  );
  const { boundTurnId, boundTaskId, state } = widget;
  const phase = phaseOf(state);
  const capabilities = capabilitiesOf(state, {
    summoned: placement.summoned === true,
  });
  // The draft is document content, so it arrives as a prop from the node
  // view (which re-renders on every document change) rather than from the
  // service. `draftIO` is how the actions write it back.
  const draft = placement.draft ?? "";
  const reference = placement.reference ?? null;
  const draftIO = useDraftIO(prompts, editor, blobId, workspacePath);

  const { label: harnessLabel } = host.useDefaultHarness();
  const actions = usePromptBlobActions({
    prompts,
    blobId,
    workspacePath,
    documentPath,
    editor,
    getPos,
    summoned: placement.summoned === true,
    reference,
    removeNode: placement.removeNode,
    draftIO,
  });

  const { turn, task, sortedEntries, taskTurns } = usePromptBlobRound({
    boundTurnId,
    boundTaskId,
  });

  useInFlightEscape({
    prompts,
    blobId,
    stoppable: capabilities.escape === "stop",
    stop: actions.stop,
  });
  const escapeToEditor = usePromptBlobFocus({
    blobId,
    editor,
    documentPath,
    getPos,
    draftIO,
  });

  const choice = useChoiceAnswer(widget, draft, actions.sendFollowUp);
  const { sendFollowUp, pickOption } = choice;

  const display = {
    ...usePromptBlobDisplay({
      review: prompts.review,
      blobId,
      editor,
      phase,
      widget,
      sortedEntries,
      taskTurns,
    }),
    choice: choice.display,
  };

  useComposerKeys({
    blobId,
    documentPath,
    draftIO,
    capabilities,
    composing: state.name === "composing",
    actions: { ...actions, sendFollowUp, escapeToEditor },
    choiceKey: choice.onKey,
  });

  const openBoundChat = openBoundChatAction(host, boundTaskId);
  const removalRefused = useRecently(widget.removalRefusedAt, 1500);

  return {
    phase,
    rules: {
      fieldEditable: capabilities.fieldEditable,
      removalRefused,
      removalRefusedAt: widget.removalRefusedAt,
    },
    record: widget,
    task,
    boundTaskId,
    workspacePath,
    trustName: harnessLabel,
    confirmTrust: state.name === "composing" && state.confirmingTrust,
    isSending: state.name === "sending",
    display,
    draft,
    draftIO,
    draftSlot: placement.draftSlot,
    reference,
    clearReference: placement.clearReference,
    documentPath,
    actions: {
      ...actions,
      sendFollowUp,
      pickOption,
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
 * The widget's send paths (round one + reply). The service runs the state
 * machine through `sending` and binds what the dispatch returns; this hook
 * owns what only the face knows — the trust gate, the draft, and where in
 * the document the prompt was sent from.
 */
function usePromptSendActions({
  prompts,
  blobId,
  workspacePath,
  documentPath,
  editor,
  getPos,
  draftIO,
}: {
  prompts: PromptWidgetsApi;
  blobId: string;
  workspacePath: string;
  documentPath: string;
  editor: Editor;
  getPos?: () => number | undefined;
  draftIO: DraftIO;
}) {
  const { t } = useTranslation();
  const host = usePromptWidgetHost();
  const trust = host.useTrust(workspacePath);

  // The one prompt dispatch both send paths share: they differ only in
  // which task they target. The widget-context facts are read fresh on
  // every call — a reply may follow a round that filled the doc or moved
  // the node.
  const dispatchPrompt = useCallback(
    (taskId: string, text: string) => {
      const doc = editor.state.doc;
      // The reference rides the node, so it too is read fresh: a follow-up
      // keeps sending the round's referent for as long as the attr exists
      // (a re-parse from the file marker drops it, like the draft).
      const nodePos = findPromptNodePos(doc, blobId);
      const reference =
        nodePos !== null
          ? ((doc.nodeAt(nodePos)?.attrs.reference ??
              null) as PromptReference | null)
          : null;
      const { turnId, sentPrompt } = host.dispatchPrompt({
        taskId,
        text,
        workspacePath,
        target: widgetPromptTarget({
          documentPath,
          workspacePath,
          pos: getPos?.(),
          docContentSize: doc.content.size,
          isDocEmpty: !docHasRealContent(doc),
          reference,
          toRelativePath: host.toRelativePath,
        }),
      });
      return { taskId, turnId, workspacePath, documentPath, sentPrompt };
    },
    [host, blobId, documentPath, workspacePath, editor, getPos],
  );

  const send = useCallback(async () => {
    const text = draftIO.read().trim();
    if (!text) return;
    if (!host.ensureRuntime()) return;
    const { state } = prompts.get(blobId);
    const confirming = state.name === "composing" && state.confirmingTrust;
    if (!trust.isTrusted && !confirming) {
      prompts.askTrust(blobId);
      return;
    }
    if (confirming) {
      trust.grant();
      prompts.answerTrust(blobId);
    }
    const sent = await prompts.send(blobId, text, async () => {
      const taskId = await resolvePromptTarget(
        host,
        prompts.get(blobId).boundTaskId,
        workspacePath,
      );
      return dispatchPrompt(taskId, text);
    });
    if (!sent) return;
    draftIO.write("");
    // The field closes while the agent works: the caret goes back to
    // the document rather than staying in a draft that takes no typing.
    draftIO.leave();
  }, [prompts, host, blobId, trust, workspacePath, dispatchPrompt, draftIO]);

  // Reply (MET-92): continue the conversation on the BOUND task — never the
  // shared session, which the picker may have re-targeted since this
  // widget's first round. A new FIFO turn on the same ACP session. No
  // trust gate: round one already required it for this workspace.
  // `compose` turns the draft into the prompt (a choice answer adds the
  // picked options to it).
  const sendFollowUp = useCallback(async (
    compose: (draft: string) => string = (draft) => draft,
  ) => {
    const text = compose(draftIO.read()).trim();
    const taskId = prompts.get(blobId).boundTaskId;
    if (!text || !taskId) return;
    if (!host.ensureRuntime()) return;
    // dispatchPrompt is infallible by contract: a missing task mints a
    // turnId whose row never appears. Check first; on a dead task keep the
    // draft and fall back to composing (re-send starts a fresh session).
    // Reachable covers a session that is merely asleep: a widget restored
    // from the document (MET-163) has no runtime until this prompt revives
    // it via session/load, which is exactly the point of persisting it.
    if (!(await host.isTaskReachable(taskId))) {
      toast(t("promptBlobSessionGone"));
      prompts.unbind(blobId);
      return;
    }
    const sent = await prompts.send(blobId, text, async () =>
      dispatchPrompt(taskId, text),
    );
    if (!sent) return;
    draftIO.write("");
    // The field closes while the agent works: the caret goes back to
    // the document rather than staying in a draft that takes no typing.
    draftIO.leave();
  }, [prompts, host, blobId, dispatchPrompt, t, draftIO]);

  return { send, sendFollowUp };
}

/**
 * The widget's imperative actions, extracted from PromptBlob so the
 * component body stays layout + phase branching. Every callback reads the
 * service and the document at call time rather than closing over render
 * values, so the callbacks stay stable across state changes.
 */
function usePromptBlobActions({
  prompts,
  blobId,
  workspacePath,
  documentPath,
  editor,
  getPos,
  summoned,
  reference,
  removeNode,
  draftIO,
}: PromptBlobPlacement & {
  summoned: boolean;
  reference: PromptReference | null;
  draftIO: DraftIO;
}) {
  const host = usePromptWidgetHost();
  const { send, sendFollowUp } = usePromptSendActions({
    prompts,
    blobId,
    workspacePath,
    documentPath,
    editor,
    getPos,
    draftIO,
  });

  // Unbind and pull the sent prompt back into the composer, caret at its
  // end. A draft already being typed (a half-written reply) always wins
  // over the restored prompt. Shared by Edit and a withdrawn queued turn.
  const restorePromptToDraft = useCallback(() => {
    const { lastSentPrompt } = prompts.get(blobId);
    prompts.unbind(blobId);
    draftIO.write(draftIO.read() || lastSentPrompt);
  }, [prompts, blobId, draftIO]);

  // Edit: pull the sent prompt back into the composer. A queued turn is
  // withdrawn; a running/finished one keeps going — re-send is a new turn.
  const editPrompt = useCallback(() => {
    prompts.withdraw(blobId, host);
    restorePromptToDraft();
  }, [prompts, host, blobId, restorePromptToDraft]);

  // Retry: pull the failed prompt back into the composer and immediately
  // re-send it, no re-typing required.
  const retry = useCallback(() => {
    editPrompt();
    void send();
  }, [editPrompt, send]);

  // Stop (the button, and Escape while the agent works): a queued turn is
  // withdrawn and its prompt comes back to the composer; a running one is
  // cancelled and the widget stays on its round, which settles as Stopped.
  const stop = useCallback(() => {
    if (prompts.stop(blobId, host) === "withdrawn") restorePromptToDraft();
  }, [prompts, host, blobId, restorePromptToDraft]);

  // In a doc with real content the widget is transient — ✕ removes the
  // node outright. In an empty doc removal is pointless (the keeper would
  // reinsert), so just reset to composing.
  const dismiss = useCallback(() => {
    prompts.unbind(blobId);
    if (removeNode && docHasRealContent(editor.state.doc)) removeNode();
  }, [prompts, blobId, removeNode, editor]);

  // The revert half of the "/" summon: Esc or a second "/" while the
  // composer is still empty turns the widget back into a literal "/". A
  // selection-summoned widget never inserted a "/", so its revert is plain
  // removal with the caret restored — deliberately, a second "/" there
  // dismisses rather than reverting-to-slash.
  const revertToSlash = useMemo(() => {
    if (!summoned || !removeNode) return undefined;
    return reference
      ? () => removeNode({ restoreCaret: true })
      : () => removeNode({ insertSlash: true });
  }, [summoned, reference, removeNode]);

  // Backspace on an empty composer: the widget just disappears. A summoned
  // instance restores the paragraph the summon consumed (as if "/" was
  // never typed); one restored from a saved marker is removed outright —
  // that edit drops the marker from the file, and ⌘Z brings it back. In a
  // doc with no real content removal is pointless (the keeper would
  // reinsert with the caret kicked out of the draft), so nothing happens —
  // the extension's Backspace clamp swallows the key either way (repro:
  // prompt-widget-backspace.test.tsx).
  const backspaceDismiss = useMemo(() => {
    if (!removeNode) return undefined;
    return () => {
      if (summoned) {
        // A selection summon consumed no paragraph — deleting the widget
        // and restoring the caret is the whole "as if never typed".
        removeNode(
          reference ? { restoreCaret: true } : { restoreParagraph: true },
        );
        return;
      }
      if (docHasRealContent(editor.state.doc)) removeNode();
    };
  }, [summoned, reference, removeNode, editor]);

  // Picking a session on a widget that already belongs to one re-targets
  // THIS widget (and its document marker), rather than only moving the
  // workspace's shared session — otherwise the icon would name one session
  // and the prompt would go to another.
  const rebindSession = useCallback(
    (taskId: string) => {
      host.adoptSession(workspacePath, taskId);
      prompts.rebind(blobId, taskId);
    },
    [prompts, host, blobId, workspacePath],
  );

  return {
    send,
    sendFollowUp,
    editPrompt,
    retry,
    stop,
    dismiss,
    revertToSlash,
    backspaceDismiss,
    rebindSession,
  };
}

/** True for `ms` after `at` — a moment the face shows briefly. */
function useRecently(at: number | null, ms: number): boolean {
  const [now, setNow] = useState(() => Date.now());
  const recent = at !== null && now - at < ms;
  useEffect(() => {
    if (at === null) return;
    setNow(Date.now());
    const timeout = setTimeout(() => setNow(Date.now()), ms);
    return () => clearTimeout(timeout);
  }, [at, ms]);
  return recent;
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
 * The draft row: the one place the widget's content hole lives.
 *
 * ProseMirror requires a node's contentDOM to stay mounted, so the hole is
 * rendered here unconditionally and never moves between parents — the phase
 * dresses the row around it (session picker and trust warning while
 * composing, a divider while replying) and hides it outright in the phases
 * that have no composer at all. That single hole is also why the initial
 * composer and the follow-up reply can share one draft: they are the same
 * text in the document, at different points in the round.
 */
function DraftRow({
  phase,
  editable,
  draftSlot,
  empty,
  confirmTrust,
  trustName,
  workspacePath,
  boundTaskId,
  onSelectSession,
  focusComposer,
}: {
  phase: BlobPhase;
  /** Takes typing; otherwise hidden and closed to the caret. Unset (a
   *  face with no widget behind it): read off the phase. */
  editable?: boolean;
  draftSlot: React.ReactNode;
  empty: boolean;
  confirmTrust: boolean;
  trustName: string;
  workspacePath: string;
  boundTaskId?: string | null;
  onSelectSession?: (taskId: string) => void;
  /** Put the caret back in this widget's composer. */
  focusComposer: () => void;
}) {
  const { t } = useTranslation();
  const composing = phase === "composing";
  const open = editable ?? takesTyping(phase);
  return (
    <div className="flex flex-col" hidden={!open}>
      <div
        className={cn(
          "flex items-start",
          composing
            ? "gap-1.5 px-1.5 py-1"
            : "mt-1 gap-1.5 border-t border-border/60 px-2.5 pt-1.5",
        )}
      >
        {composing ? (
          <div contentEditable={false}>
            <SessionControl
              workspacePath={workspacePath}
              boundTaskId={boundTaskId}
              onSelectSession={onSelectSession}
              onClose={focusComposer}
            />
          </div>
        ) : null}
        {/* The placeholder is painted from here rather than by the editor's
            Placeholder extension: that extension has one string for the
            whole document, and this row knows which prompt it is asking
            for. */}
        <div
          data-prompt-draft=""
          // A field that doesn't take typing is outside the editing host:
          // nothing — keys, IME, spellcheck, a stray click — edits it.
          contentEditable={open ? undefined : false}
          data-empty={empty ? "true" : "false"}
          data-placeholder={t(draftPlaceholderKey(phase))}
          className={cn(
            "prompt-editor relative min-w-0 flex-1 whitespace-pre-wrap break-words",
            composing ? "pt-1 pb-1.5 text-sm" : "text-xs",
          )}
        >
          {draftSlot}
        </div>
      </div>
      {composing && confirmTrust && (
        <span
          contentEditable={false}
          className="px-3 pb-1.5 text-[0.6875rem] text-warning"
        >
          {t("promptBlobTrustWarning", { name: trustName })}
        </span>
      )}
    </div>
  );
}

function draftPlaceholderKey(phase: BlobPhase) {
  if (phase === "composing") return "promptBlobPlaceholder";
  return phase === "needs-answer" ? "promptBlobAnswer" : "promptBlobReply";
}

/**
 * The session picker, logo-only trigger in the composer row: shows where
 * the next prompt actually goes (the adopted session's harness logo, or the
 * default harness if nothing is adopted). The menu offers the workspace's
 * recent live sessions to re-target, or a new conversation on one of the top
 * harnesses — each its own entry with its logo; picking one also becomes the
 * remembered default (the sessions panel's split-button rule).
 */
function SessionControl({
  workspacePath,
  boundTaskId,
  onSelectSession,
  onClose,
}: {
  workspacePath: string;
  /** The session this widget is already bound to (a restored widget, MET-163)
   *  — the icon must name where the prompt will actually go, which is this
   *  task rather than the workspace's shared session. */
  boundTaskId?: string | null;
  /** Re-target a bound widget. Absent for an unbound one, whose selection
   *  just moves the shared session as it always did. */
  onSelectSession?: (taskId: string) => void;
  /** The menu is a detour from typing: when it closes, the caret goes back
   *  to the composer (as the chat tab's pickers do). */
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const host = usePromptWidgetHost();
  const { HarnessLogo } = host.slots;
  // Default first, never empty — the top three become the explicit
  // new-conversation entries below.
  const harnesses = host.useHarnessList();
  // Already filtered to live sessions and ordered newest-first by the host.
  const sessions = host.useSessionList(workspacePath);
  const [open, setOpen] = useState(false);

  const peekedTaskId = boundTaskId ?? host.peekSession(workspacePath);
  // The trigger's logo names where the prompt would go. The session it points
  // at is in the list whenever it is live, so no second lookup is needed.
  const triggerHarnessId =
    sessions.find((session) => session.taskId === peekedTaskId)?.harnessId ??
    harnesses[0].id;

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
      <DropdownMenuContent
        align="start"
        onCloseAutoFocus={(event) => {
          // Radix would hand focus back to the trigger.
          event.preventDefault();
          onClose();
        }}
      >
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
        {harnesses.slice(0, 3).map((harness) => (
          <DropdownMenuItem
            key={harness.id}
            className="cursor-pointer gap-2 text-xs"
            onSelect={() => host.dropSession(workspacePath, harness.id)}
          >
            <HarnessLogo
              harnessId={harness.id}
              className="size-3 text-muted-foreground"
            />
            {t("promptBlobNewSessionWith", { harness: harness.label })}
          </DropdownMenuItem>
        ))}
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

/** The done face's first row: status icon + the one-line outcome summary.
 *  The line doubles as the expand/collapse toggle when there's a body to
 *  show (disabled otherwise — a bare Done/Stopped label has nothing to
 *  expand). Amber tint mirrors the issue callout below. */
/** The selection this widget was summoned over — one muted line above the
 *  face, in every phase: the sent and done cards keep showing what the
 *  round was about. Truncated to a single line; the tooltip carries a
 *  larger (still bounded) window of the captured text. The ✕ drops the
 *  reference and leaves a regular widget behind. */
export function ReferenceChip({
  text,
  phase,
  onRemove,
}: {
  text: string;
  phase: BlobPhase;
  onRemove?: () => void;
}) {
  const { t } = useTranslation();
  const firstLine = text.split("\n", 1)[0];
  const remove = referenceRemovalArmed(phase) ? onRemove : undefined;
  return (
    <div className="px-2 pt-1.5 text-[0.5625rem] leading-tight text-muted-foreground/80">
      {/* The whole quote is one hoverable box: highlighting it as a unit is
          what scopes the ✕ inside to the quote — a corner ✕ on the card
          reads as "dismiss the widget". */}
      <div
        // inline-flex, not flex: the box hugs the quote instead of claiming
        // the card's full width — hover only lights up where the text is.
        className="group/ref inline-flex max-w-full items-center gap-1 rounded-sm px-1 py-0.5 transition-colors hover:bg-accent/50"
        title={text.length > 600 ? `${text.slice(0, 600)}…` : text}
      >
        <TextQuote className="size-2.5 shrink-0" />
        <span className="min-w-0 truncate italic">{firstLine}</span>
        {remove && (
          <button
            type="button"
            aria-label={t("promptBlobReferenceRemove")}
            className="shrink-0 cursor-pointer rounded-sm p-0.5 opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/ref:opacity-100"
            onClick={remove}
          >
            <X className="size-2.5" />
          </button>
        )}
      </div>
    </div>
  );
}

/** What a file chip does. The widget's own document is already open, so
 *  its chip toggles the highlighting there; another document the round
 *  marked opens with the highlighting on — that is why you go there; any
 *  other chip just opens its file. */
type ChipAction = "toggle" | "open-highlighted" | "open";

function chipAction(
  path: string,
  documentPath: string,
  changeCounts: ReadonlyMap<string, number>,
  changes: PromptChangeNavigation | undefined,
): ChipAction {
  if (!changes || !changeCounts.has(path)) return "open";
  return path === documentPath ? "toggle" : "open-highlighted";
}

/** The documents a finished turn wrote to, each a shortcut back into the
 *  file — and the switch for highlighting what the round changed (see
 *  `chipAction`). Its own component so the done face stays readable — that
 *  face is already the branchiest part of the widget. */
function TouchedFileChips({
  paths,
  documentPath,
  changeCounts,
  changes,
  onOpenFile,
}: {
  paths: string[];
  documentPath: string;
  changeCounts: ReadonlyMap<string, number>;
  changes: PromptChangeNavigation | undefined;
  onOpenFile: (path: string) => void;
}) {
  const { t } = useTranslation();
  if (paths.length === 0) return null;
  const highlighting = Boolean(changes?.reviewing);
  return (
    <div className="flex flex-wrap items-center gap-1">
      {paths.map((path) => {
        const action = chipAction(path, documentPath, changeCounts, changes);
        if (action === "open" || !changes) {
          return (
            <button
              key={path}
              type="button"
              className={cn(fileChipClass, fileChipIdleClass)}
              onClick={() => onOpenFile(path)}
            >
              <FileText className="size-3" />
              {basename(path)}
            </button>
          );
        }
        const on = highlighting;
        return (
          <button
            key={path}
            type="button"
            aria-pressed={action === "toggle" ? on : undefined}
            className={cn(
              fileChipClass,
              on
                ? "bg-(--prompt-change)/15 text-foreground hover:bg-(--prompt-change)/25"
                : fileChipIdleClass,
            )}
            // The dot and the tint take the colour of this widget's gutter
            // bars — the chip and the marks it shows read as one thing.
            style={{ "--prompt-change": changes.color } as CSSProperties}
            onClick={() => {
              if (action === "toggle") return changes.toggleReview();
              changes.showChanges();
              onOpenFile(path);
            }}
          >
            <ChangeDot on={on} />
            {basename(path)}
            {/* The dot says what the chip toggles to the eye; this says it
                to a screen reader. aria-pressed carries on/off. */}
            <span className="sr-only">{t("promptChangesHighlight")}</span>
          </button>
        );
      })}
    </div>
  );
}

const fileChipClass =
  "flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-[0.6875rem] transition-colors";
const fileChipIdleClass =
  "bg-muted text-muted-foreground hover:bg-accent hover:text-foreground";

/** The chip's key to the gutter: a dot in the bars' colour, hollow while
 *  they are hidden, filled while they show. Sits in the icon's 12px box. */
function ChangeDot({ on }: { on: boolean }) {
  return (
    <span aria-hidden className="flex size-3 items-center justify-center">
      <span
        className={cn(
          "size-2 rounded-full ring-[1.5px] ring-(--prompt-change) ring-inset transition-colors",
          on ? "bg-(--prompt-change)" : "bg-transparent",
        )}
      />
    </span>
  );
}

/** Done: the widget's single resting face — the response as
 *  WidgetResponseView renders it (the chat's widget_respond card shows the
 *  same view), plus this placement's own chrome: Open chat and Dismiss in
 *  the heading row, the touched-file chips below.
 *  No Edit here: Reply continues the session, ✕ dismisses; rewriting from
 *  scratch is what a fresh widget is for.
 *  Exported for tests only — mounting the whole PromptBlob needs Tiptap and
 *  live collections; the done face is testable standalone. */
export function DoneState({
  choices,
  cancelled,
  response,
  fallbackText,
  touchedFiles,
  documentPath = "",
  changeCounts = new Map(),
  changes,
  onOpenFile,
  onOpenChat,
  onDismiss,
}: {
  /** The open choice question's controls, under the question. */
  choices?: React.ReactNode;
  cancelled: boolean;
  response: WidgetResponse | null;
  /** Latest assistant text of the bound turn — the summary line when the
   *  agent didn't deliver a widget_respond response. */
  fallbackText: string | null;
  touchedFiles: string[];
  /** The document this widget sits in — its chip is the highlight toggle. */
  documentPath?: string;
  changeCounts?: ReadonlyMap<string, number>;
  changes?: PromptChangeNavigation;
  onOpenFile: (path: string) => void;
  onOpenChat: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  return (
    <WidgetResponseView
      response={response}
      fallbackText={fallbackText}
      cancelled={cancelled}
      actions={
        <>
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
        </>
      }
    >
      {choices}
      <TouchedFileChips
        paths={touchedFiles}
        documentPath={documentPath}
        changeCounts={changeCounts}
        changes={changes}
        onOpenFile={onOpenFile}
      />
    </WidgetResponseView>
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
}: {
  message: string | undefined;
  onRetry: () => void;
  onEdit: () => void;
  onDismiss: () => void;
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
    </div>
  );
}

/**
 * A choice question's answer: what is picked, which option the keys are
 * on, and how the reply carries the picks. Held per round: a new round (a
 * later question, or none) starts with nothing picked. Typing in the field
 * leaves the options. `sendFollowUp` and `pickOption` replace the plain
 * reply: outside a choice nothing is picked, so the reply is the draft.
 */
function useChoiceAnswer(
  widget: PromptWidget,
  draft: string,
  sendReply: (compose: (draft: string) => string) => Promise<void>,
) {
  const response = widget.outcome?.response ?? null;
  const asking =
    widget.state.name === "asking" && widget.state.ask.kind === "question";
  const options = asking ? (response?.options ?? null) : null;
  const multiple = response?.kind === "multiple_choice";
  const turnId = widget.boundTurnId;
  const [picks, setPicks] = useState<ChoicePicks>(() => noPicks(turnId));
  const round = options && picks.turnId === turnId ? picks : noPicks(turnId);
  /** Change this round's picks; another round's start from nothing. */
  const update = useCallback(
    (change: (round: ChoicePicks) => Partial<ChoicePicks>) =>
      setPicks((previous) => {
        const base = previous.turnId === turnId ? previous : noPicks(turnId);
        const next = { ...base, ...change(base) };
        return next.picked === previous.picked &&
          next.focused === previous.focused &&
          next.turnId === previous.turnId
          ? previous
          : next;
      }),
    [turnId],
  );
  const focus = useCallback(
    (index: number | null) => update(() => ({ focused: index })),
    [update],
  );
  useEffect(() => focus(null), [draft, focus]);

  const sendFollowUp = useCallback(
    () => sendReply((typed) => composeChoiceAnswer(round.picked, typed)),
    [sendReply, round.picked],
  );
  const pickOption = useCallback(
    (option: string) => {
      if (!multiple) {
        void sendReply((typed) => composeChoiceAnswer([option], typed));
        return;
      }
      update(({ picked }) => ({
        picked: picked.includes(option)
          ? picked.filter((each) => each !== option)
          : [...picked, option],
      }));
    },
    [multiple, sendReply, update],
  );
  /** A key in the field: consumed or not, or null when it isn't one of the
   *  options' keys (deriveChoiceKey). */
  const onKey = (key: string, typed: string): boolean | null => {
    if (!options) return null;
    const action = deriveChoiceKey({
      key,
      focused: round.focused,
      count: options.length,
      multiple,
      picked: round.picked.length,
      draftEmpty: typed.trim().length === 0,
    });
    if (!action) return null;
    if ("focus" in action) {
      focus(action.focus);
      return action.consumed;
    }
    if ("send" in action) void sendFollowUp();
    else {
      focus(action.pick);
      pickOption(options[action.pick]);
    }
    return true;
  };
  const display: ChoiceDisplay | null = options
    ? { options, multiple, picked: round.picked, focused: round.focused }
    : null;
  return { display, sendFollowUp, pickOption, onKey };
}

type ChoiceAnswer = ReturnType<typeof useChoiceAnswer>;

type ChoicePicks = {
  turnId: string | null;
  picked: string[];
  /** The option the keys are on; null while they are in the field. */
  focused: number | null;
};

function noPicks(turnId: string | null): ChoicePicks {
  return { turnId, picked: [], focused: null };
}

/** A choice question's options, inline: a chip per option. A single
 *  choice's chip answers on click; a multiple choice's chip carries a
 *  checkbox, and once something is picked a small send arrow ends the row
 *  (Enter sends the picks too). While the keys are on the options (↑ from
 *  the field) the focused chip is ringed and each chip shows the digit
 *  that picks it. The field below still takes a typed answer or a note. */
function ChoiceOptions({
  choice,
  onPick,
  onSend,
}: {
  choice: ChoiceDisplay;
  onPick: (option: string) => void;
  onSend: () => void;
}) {
  const { t } = useTranslation();
  const navigating = choice.focused !== null;
  return (
    <div
      className="flex flex-wrap items-center gap-1.5 pt-0.5"
      data-choice={choice.multiple ? "multiple" : "single"}
    >
      {choice.options.map((option, index) => {
        const picked = choice.picked.includes(option);
        const chip = cn(
          choiceChipClass,
          choice.focused === index && "ring-1 ring-ring",
          picked && "border-foreground/30 bg-accent text-foreground",
        );
        const digit = navigating && index < 9 && (
          <kbd className="font-sans text-[0.625rem] text-muted-foreground">
            {index + 1}
          </kbd>
        );
        return choice.multiple ? (
          <label key={option} className={chip} data-choice-focused={choice.focused === index || undefined}>
            <Checkbox
              className="size-3 rounded-[3px] [&_svg]:size-2.5"
              checked={picked}
              onCheckedChange={() => onPick(option)}
              data-choice-option={option}
            />
            {option}
            {digit}
          </label>
        ) : (
          <button
            key={option}
            type="button"
            className={chip}
            data-choice-option={option}
            data-choice-focused={choice.focused === index || undefined}
            onClick={() => onPick(option)}
          >
            {option}
            {digit}
          </button>
        );
      })}
      {choice.multiple && choice.picked.length > 0 && (
        <button
          type="button"
          aria-label={t("send")}
          title={t("send")}
          className="ml-auto cursor-pointer rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          onClick={onSend}
        >
          <CornerDownLeft className="size-3.5" />
        </button>
      )}
    </div>
  );
}

const choiceChipClass =
  "flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-2 py-0.5 text-xs text-foreground/80 transition-colors hover:bg-accent hover:text-foreground";
