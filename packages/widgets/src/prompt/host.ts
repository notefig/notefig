/**
 * Everything the prompt widget cannot compute from its own document.
 *
 * Rule 3 of the widget protocol (../define-widget.ts): the widget owns its
 * codec, its schema node, its state machine and its chrome, and reaches the
 * application through this one object and nothing else. It is passed once —
 * to `widgetRendererNodes()` for the ProseMirror half, and through
 * `PromptWidgetHostProvider` for the React half.
 *
 * What is NOT here is as deliberate as what is. Anything the widget can
 * decide for itself stays in the package: which session a prompt targets
 * when the widget is already bound (`resolvePromptTarget`), what phase the
 * rows add up to (`derivePhase`), what the composer does with a keystroke
 * (`deriveComposerKeyAction`). The host answers questions about the app —
 * "is this session still alive?", "what files are in the workspace?" — never
 * questions about the widget.
 *
 * `slots` carries the four surfaces the widget renders but does not own: a
 * markdown renderer backed by the app's conversion worker, the permission
 * and auth cards that speak to the agent service, and the workspace's file
 * icon. They cross as components rather than as duplicated code.
 */
import type { ComponentType } from "react";
import type {
  AgentEntry,
  AgentPermissionRequestRow,
  AgentTaskRow,
  AgentTurn,
} from "@notefig/shared/agent";

/** Where in the document a widget's prompt was sent from. */
export interface WidgetPromptTarget {
  /** Workspace-relative document path (absolute if outside the workspace). */
  path: string;
  /** Document position the widget sat at when the prompt was sent. */
  pos: number;
  isDocEmpty: boolean;
}

/** The live rows behind one widget's bound round. */
export interface PromptRound {
  turn: AgentTurn | undefined;
  task: AgentTaskRow | undefined;
  /** This turn's transcript, in chronological order. */
  entries: AgentEntry[];
  /** Every turn on the bound task — for the queue-position readout. */
  taskTurns: AgentTurn[];
  pendingPermissions: AgentPermissionRequestRow[];
}

/** One entry in the widget's session picker. */
export interface SessionOption {
  taskId: string;
  title: string;
  /** Pre-resolved one-line summary (relative time, turn count, …). */
  description: string;
  /** Which harness runs it — picks the logo. */
  harnessId: string;
}

/**
 * A workspace file offered by the "@" mention popup. Deliberately the shape
 * the app's own file ranking already produces, so the host maps nothing:
 * `relativePath` is what a mention token resolves to, `title` is the file
 * name, and `path` is the absolute path — needed only to pick the icon.
 */
export interface MentionCandidate {
  /** Tree-domain ("/"-separated) path, relative to the workspace root. */
  relativePath: string;
  /** File name, shown whole (the directory prefix truncates first). */
  title: string;
  /** Absolute path — for the file-type icon only. */
  path: string;
}

export interface PromptWidgetHost {
  // ── the agent session this widget prompts ────────────────────────────
  /**
   * The workspace's shared session, started on first use. Resolves only once
   * the session is ready to prompt — prompting before the ACP handshake
   * completes settles the turn as an error.
   */
  startOrGetSharedSession(workspacePath: string): Promise<string>;
  /** Point the shared session at an existing live task (session picker). */
  adoptSession(workspacePath: string, taskId: string): void;
  /** Forget the shared session, so the next send starts a fresh one on
   *  `harnessId` — which also becomes the remembered default, mirroring the
   *  sessions panel's split button. The old task is not cancelled — it stays
   *  in the app's session list. */
  dropSession(workspacePath: string, harnessId: string): void;
  /** The current shared session, for rendering only. */
  peekSession(workspacePath: string): string | null;
  /**
   * Whether a task can still be prompted. True for a merely sleeping session
   * — a widget restored from the document has no runtime until its next
   * prompt revives it via session/load, which is the point of persisting it.
   */
  isTaskReachable(taskId: string): Promise<boolean>;

  // ── sending and stopping ─────────────────────────────────────────────
  /**
   * Send a prompt from this widget. The host resolves the text's "@" mentions
   * into context parts itself — the widget hands over the finished string.
   * Infallible by contract: it returns the id of the turn to watch.
   */
  dispatchPrompt(args: {
    taskId: string;
    text: string;
    workspacePath: string;
    target: WidgetPromptTarget;
  }): { turnId: string };
  cancelTask(taskId: string): void;
  /**
   * Cancel the running turn and drop it from the transcript when the agent
   * had not responded yet. Resolves true iff the round was forgotten — which
   * is what tells the widget it may restore the prompt to the composer.
   */
  cancelTurnAndForget(taskId: string): Promise<boolean>;
  /** Withdraw a turn that is still queued behind others. */
  removeQueuedPrompt(taskId: string, turnId: string): void;
  /** Status of a single turn, read at call time (not a subscription). */
  getTurnStatus(turnId: string): AgentTurn["status"] | undefined;
  /** False when no agent runtime is available; the host surfaces the reason. */
  ensureRuntime(): boolean;

  // ── live state ───────────────────────────────────────────────────────
  useRound(args: { turnId: string | null; taskId: string | null }): PromptRound;
  /** Live sessions in this workspace, newest first, ready to render. */
  useSessionList(workspacePath: string): SessionOption[];
  /** The harness a new session would use. The host picks it; the widget only
   *  names it (trust prompt) and draws its logo. */
  useDefaultHarness(): { id: string; label: string };
  /** The harnesses a new conversation may start on, default first. Never
   *  empty; the widget offers the top of this list as explicit
   *  new-conversation entries. */
  useHarnessList(): { id: string; label: string }[];
  /**
   * The workspace's "yes, agents may act here" gate, asked once per
   * workspace before the first send.
   */
  useTrust(workspacePath: string): {
    isTrusted: boolean;
    grant: () => void;
  };

  // ── workspace files, for "@" mentions ────────────────────────────────
  /** Does this tree-domain token name a real file in the workspace? */
  isWorkspaceFile(workspacePath: string, relativePath: string): boolean;
  searchWorkspaceFiles(
    workspacePath: string,
    query: string,
    limit: number,
  ): MentionCandidate[];
  /**
   * Tree-domain path of `absolutePath` relative to `workspacePath`, or
   * undefined when it falls outside. Path spelling is a platform fact (posix
   * vs win32), so the app owns this rather than the widget.
   */
  toRelativePath(
    workspacePath: string,
    absolutePath: string,
  ): string | undefined;

  // ── app chrome ───────────────────────────────────────────────────────
  openFile(path: string): void;
  openAgentTab(taskId: string): void;
  /**
   * Claim focus for the document, through the app's focus arbiter — an
   * explicit hand-off, so `steal` is the widget's to ask for. The caret is
   * already the document's own selection (the draft is document content),
   * so there is nothing else to say.
   */
  focusDocument(
    documentPath: string,
    options: { reason: string; steal?: boolean },
  ): void;

  slots: {
    Markdown: ComponentType<{ text: string; className?: string }>;
    PermissionCard: ComponentType<{ taskId: string }>;
    AuthCard: ComponentType<{ task: AgentTaskRow }>;
    FileIcon: ComponentType<{ path: string; className?: string }>;
  };
}
