import {
  createRef,
  useCallback,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { PromptEditor, type PromptEditorHandle } from "@notefig/widgets";
import { PromptBlobFace } from "@notefig/widgets/prompt/ui/prompt-blob";
import {
  deriveActiveToolLine,
  deriveLatestAssistantLine,
  deriveTouchedFiles,
  deriveWidgetResponse,
  type BlobPhase,
} from "@notefig/widgets/prompt/state";
import type { AgentEntry, AgentTurn } from "@notefig/shared/agent";
import { BUILT_IN_HARNESSES } from "@notefig/shared/agent";
import i18n from "@/utils/intl";
import { describeTaskMeta } from "@/entities/agents";
import { formatTimeAgo } from "@/utils/format";
import { EntryView, PromptBox } from "@/components/agent/agent-chat-tab";
import { HarnessRow } from "@/components/agent/harness-settings";
import { SessionRow } from "@/components/agent/sessions-panel";
import {
  StatusGlyph,
  type StatusGlyphState,
} from "@/components/agent/status-glyph";
import { HarnessLogo } from "@notefig/ui/harness-logo";
import { CheckpointsList } from "@/components/editor/git/checkpoint-panel";
import { DemoHost } from "./demo-host";
import {
  DEMO_CHECKPOINTS,
  DEMO_ROOT,
  DEMO_SESSIONS,
  DEMO_TRANSCRIPT,
} from "./demo-fixtures";
import { useDemoScript } from "./use-demo-script";

/*
 * Real app components on the marketing page. Each demo renders the app's own
 * component — not a picture of it — inside `AppEmbed`, fed by the fake
 * environment in ./demo-host and ./demo-fixtures and stepped by a script.
 */

const noop = () => {};

/**
 * The app's own type, spacing and theme tokens for a subtree of the
 * marketing page (which rescales Tailwind's spacing for itself), shrunk to
 * card size with `zoom` so the component keeps its real proportions.
 *
 * Sizes are visual page px: `width` is a maximum — the embed fills its
 * container up to it — and the embed's own box is that divided by `zoom`.
 */
export function AppEmbed({
  zoom = 0.66,
  width,
  height,
  className,
  children,
}: {
  zoom?: number;
  width?: number;
  height?: number;
  className?: string;
  children: ReactNode;
}) {
  const [available, setAvailable] = useState<number | null>(null);
  const observer = useRef<ResizeObserver | null>(null);
  const measure = useCallback((node: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!node) return;
    observer.current = new ResizeObserver(([entry]) =>
      setAvailable(entry.contentRect.width),
    );
    observer.current.observe(node);
  }, []);
  const visualWidth =
    available === null ? width : Math.min(width ?? available, available);

  return (
    <div ref={measure} className="flex w-full min-w-0 justify-center">
      <div
        className={className ? `app-embed ${className}` : "app-embed"}
        style={
          {
            "--app-zoom": zoom,
            ...(visualWidth ? { width: visualWidth / zoom } : {}),
            ...(height ? { height: height / zoom } : {}),
          } as CSSProperties
        }
      >
        <DemoHost>{children}</DemoHost>
      </div>
    </div>
  );
}

// ---------- Harnesses: the Settings › Agents list ----------

const HARNESS_ROWS = [
  { id: "claude-code", found: true },
  { id: "opencode", found: true },
  { id: "devin", found: true },
  { id: "gemini-cli", found: false },
];

export function DemoHarnesses() {
  return (
    <AppEmbed zoom={0.82} width={340}>
      <div className="divide-y divide-border rounded-lg border border-border bg-card shadow-sm">
        {HARNESS_ROWS.map(({ id, found }) => {
          const definition = BUILT_IN_HARNESSES.find((h) => h.id === id);
          if (!definition) return null;
          return (
            <HarnessRow
              key={id}
              row={{
                definition,
                origin: "builtin",
                enabled: found,
                discovery: { harnessId: id, found, probedAt: 0 },
              }}
              isDefault={id === "claude-code"}
              isEditing={false}
              onMakeDefault={noop}
              onToggleEnabled={noop}
              onEdit={noop}
              onDelete={noop}
            />
          );
        })}
      </div>
    </AppEmbed>
  );
}

// ---------- Sessions: the sidebar's session list ----------

export function DemoSessions() {
  return (
    <AppEmbed zoom={0.82} width={360}>
      <div className="rounded-lg border border-border bg-card py-1 shadow-sm">
        {DEMO_SESSIONS.map(({ task, meta, attention }, index) => (
          <SessionRow
            key={task.taskId}
            task={task}
            meta={
              describeTaskMeta({
                task,
                needsAuth: false,
                isError: false,
                isUnavailable: false,
                ...meta,
              }) ?? formatTimeAgo(task.updatedAt)
            }
            isRunning={meta.isRunning}
            attention={attention ?? null}
            active={index === 0}
            onOpen={noop}
          />
        ))}
      </div>
    </AppEmbed>
  );
}

// ---------- The inline prompt widget, through its lifecycle ----------

const PROMPT_TEXT =
  "Turn these notes into action items with owners, and add them to @notes/roadmap.md";

type PromptFrame = {
  phase: BlobPhase;
  draft: string;
  /** The bound turn's transcript so far — the widget derives its status
   *  line, touched files and summary from these, as it does live. */
  entries?: AgentEntry[];
};

const DOC_PATH = `${DEMO_ROOT}/notes/q3-kickoff.md`;
const ROADMAP_PATH = `${DEMO_ROOT}/notes/roadmap.md`;

function toolEntry(
  id: string,
  title: string,
  status: "in_progress" | "completed",
  diff?: boolean,
): AgentEntry {
  const path = diff ? ROADMAP_PATH : DOC_PATH;
  return {
    id,
    taskId: "task_demo",
    turnId: "trn_demo",
    type: "tool_call",
    toolCallId: id,
    toolCall: {
      toolCallId: id,
      title,
      kind: diff ? "edit" : "read",
      status,
      locations: [{ path }],
      ...(diff
        ? {
            content: [
              {
                type: "diff" as const,
                path,
                oldText: "## Q3\n",
                newText:
                  "## Q3\n\n- [ ] Ship onboarding templates (Maya)\n- [ ] Pricing page for small teams (Sam)\n- [ ] Search beta to all workspaces (Lee)\n",
              },
            ],
          }
        : {}),
    },
  };
}

const REPLY: AgentEntry = {
  id: "evt_9",
  taskId: "task_demo",
  turnId: "trn_demo",
  type: "assistant",
  text: "Added three action items with owners to the Q3 section of the roadmap.",
};

const PROMPT_FRAMES: PromptFrame[] = [
  { phase: "composing", draft: "" },
  { phase: "composing", draft: PROMPT_TEXT },
  { phase: "sending", draft: PROMPT_TEXT },
  {
    phase: "running",
    draft: "",
    entries: [toolEntry("evt_1", "Read", "in_progress")],
  },
  {
    phase: "running",
    draft: "",
    entries: [
      toolEntry("evt_1", "Read", "completed"),
      toolEntry("evt_2", "Edit", "in_progress", true),
    ],
  },
  {
    phase: "done",
    draft: "",
    entries: [
      toolEntry("evt_1", "Read", "completed"),
      toolEntry("evt_2", "Edit", "completed", true),
      REPLY,
    ],
  },
];
const PROMPT_DURATIONS = [900, 2200, 700, 1600, 1800, 4200];

const RUNNING_TURN: AgentTurn = {
  turnId: "trn_demo",
  taskId: "task_demo",
  sessionId: "ses_demo",
  status: "running",
  startedAt: 0,
};

/** The widget's own derivations, run over the frame's transcript. */
function displayFor({ phase, entries = [] }: PromptFrame) {
  const done = phase === "done";
  return {
    touchedFiles: done ? deriveTouchedFiles(entries, DEMO_ROOT) : [],
    widgetResponse: done ? deriveWidgetResponse(entries) : null,
    activeToolLine: phase === "running" ? deriveActiveToolLine(entries) : null,
    assistantTeaser:
      phase === "running" || done ? deriveLatestAssistantLine(entries) : null,
    queueAhead: 0,
  };
}

/** The card version: summoned over a selection, the prompt being written. */
const SUMMON_FRAMES: PromptFrame[] = [
  { phase: "composing", draft: "" },
  { phase: "composing", draft: PROMPT_TEXT },
];
const SUMMON_DURATIONS = [1400, 3600];

const SCRIPTS = {
  summon: { frames: SUMMON_FRAMES, durations: SUMMON_DURATIONS },
  lifecycle: { frames: PROMPT_FRAMES, durations: PROMPT_DURATIONS },
};

export function DemoPromptWidget({
  script,
  reference,
  document,
  zoom = 0.7,
  width,
  className,
}: {
  script: keyof typeof SCRIPTS;
  /** Show the selection the widget was summoned over. */
  reference?: string;
  /** Document text rendered above the widget, as in the editor. */
  document?: { heading: string; body: string };
  zoom?: number;
  /** Visual width in page px. */
  width?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { frames, durations } = SCRIPTS[script];
  const frame = frames[useDemoScript(ref, durations)];
  return (
    <div ref={ref} className={className ?? "w-full min-w-0"}>
      <AppEmbed zoom={zoom} width={width}>
        {document ? (
          // The editor's own surface: the widget is a node inside the
          // document's prose, between the paragraphs it edits.
          <div className="rounded-xl border border-border bg-background px-2 py-3 shadow-sm">
            <div className="prose prose-sm max-w-none p-4">
              <h2>{document.heading}</h2>
              <p>{document.body}</p>
              <div className="not-prose">
                <PromptFace frame={frame} reference={reference} />
              </div>
            </div>
          </div>
        ) : (
          <PromptFace frame={frame} reference={reference} />
        )}
      </AppEmbed>
    </div>
  );
}

const PROMPT_ACTIONS = {
  send: noop,
  sendFollowUp: noop,
  editPrompt: noop,
  retry: noop,
  stop: noop,
  dismiss: noop,
  escapeToEditor: noop,
  rebindSession: noop,
  openBoundChat: noop,
  openFile: noop,
  openAgentTab: noop,
};

/** The widget's store record and bound turn for a frame: unbound while
 *  composing, bound to the demo turn from the send onward. */
function bindingFor(phase: BlobPhase) {
  if (phase === "composing") {
    return { taskId: null, turnId: null, turn: undefined };
  }
  const status = phase === "done" ? "completed" : "running";
  return {
    taskId: "task_demo",
    turnId: "trn_demo",
    turn: { ...RUNNING_TURN, status } as AgentTurn,
  };
}

function PromptFace({
  frame,
  reference,
}: {
  frame: PromptFrame;
  reference?: string;
}) {
  const binding = bindingFor(frame.phase);
  return (
    <PromptBlobFace
      phase={frame.phase}
      record={{
        boundTurnId: binding.turnId,
        boundTaskId: binding.taskId,
        lastSentPrompt: PROMPT_TEXT,
        documentPath: DOC_PATH,
      }}
      turn={binding.turn}
      task={undefined}
      boundTaskId={binding.taskId}
      workspacePath={DEMO_ROOT}
      documentPath={DOC_PATH}
      trustName="Claude Code"
      confirmTrust={false}
      isSending={frame.phase === "sending"}
      display={displayFor(frame)}
      draft={frame.draft}
      draftIO={{ read: () => frame.draft, write: noop, holdsCaret: () => false }}
      draftSlot={<DraftText text={frame.draft} />}
      reference={referenceFor(reference)}
      actions={PROMPT_ACTIONS}
    />
  );
}

function referenceFor(text: string | undefined) {
  return text ? { text, from: 0, to: text.length } : null;
}

/**
 * The widget's draft is document text (the editor owns it); outside an
 * editor, the real composer renders the same string — mention chips included.
 */
function DraftText({ text }: { text: string }) {
  // The draft row owns the padding, type size and placeholder (it paints the
  // placeholder itself); the editor is bare text inside it, like the
  // document paragraph it stands in for.
  return (
    <div className="pointer-events-none">
      <PromptEditor
        workspacePath={DEMO_ROOT}
        value={text}
        onChange={noop}
        placeholder=""
        className="w-full"
      />
    </div>
  );
}

// ---------- An agent session: transcript + composer ----------

/** How many transcript entries each frame shows, and which tool is live. */
const TRANSCRIPT_FRAMES = [
  { shown: 1, running: true },
  { shown: 2, running: true },
  { shown: 3, running: true, inFlight: "call_read" },
  { shown: 4, running: true, inFlight: "call_edit" },
  { shown: 5, running: false },
];
const TRANSCRIPT_DURATIONS = [1100, 1300, 1200, 1600, 5200];

function withToolStatus(entry: AgentEntry, inFlight?: string): AgentEntry {
  if (entry.type !== "tool_call" || !entry.toolCall) return entry;
  if (entry.toolCallId !== inFlight) return entry;
  return { ...entry, toolCall: { ...entry.toolCall, status: "in_progress" } };
}

export function DemoTranscript({
  width,
  height,
}: {
  width: number;
  height: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const frame = TRANSCRIPT_FRAMES[useDemoScript(ref, TRANSCRIPT_DURATIONS)];
  const [draft, setDraft] = useState("");
  const composerRef = useRef(createRef<PromptEditorHandle>()).current;
  const entries = DEMO_TRANSCRIPT.slice(0, frame.shown);

  return (
    <div ref={ref} className="w-full min-w-0">
      <AppEmbed zoom={0.8} width={width} height={height} className="flex flex-col">
        <div className="flex min-h-0 flex-1 flex-col justify-end gap-3 overflow-hidden px-1 pb-4 [mask-image:linear-gradient(transparent,black_18%)]">
          {entries.map((entry) => (
            <EntryView key={entry.id} entry={withToolStatus(entry, frame.inFlight)} />
          ))}
        </div>
        <PromptBox
          value={draft}
          onChange={setDraft}
          onSend={() => setDraft("")}
          onStop={noop}
          onCancelRestore={noop}
          isRunning={frame.running}
          taskId="task_c"
          harnessId="claude-code"
          workspacePath={DEMO_ROOT}
          composerRef={composerRef}
        />
      </AppEmbed>
    </div>
  );
}

// ---------- Workspaces: what each one's agents are up to ----------

const WORKSPACES: {
  name: string;
  harnessId: string;
  state: StatusGlyphState;
  note: string;
}[] = [
  { name: "notefig", harnessId: "claude-code", state: "running", note: "Editing 3 files" },
  { name: "api-reference", harnessId: "opencode", state: "attention-bau", note: "Finished · 2m ago" },
  { name: "q3-planning", harnessId: "claude-code", state: "queued", note: "2 prompts queued" },
  { name: "handbook", harnessId: "devin", state: "attention-error", note: "Needs you" },
  { name: "blog", harnessId: "gemini-cli", state: "idle", note: "Idle" },
];

/** The app's own status vocabulary (StatusGlyph) and harness marks, one row
 *  per open workspace — the at-a-glance view the sidebar gives you. */
export function DemoWorkspaces() {
  return (
    <AppEmbed zoom={0.9} width={420}>
      <div className="divide-y divide-border rounded-lg border border-border bg-card shadow-sm">
        {WORKSPACES.map(({ name, harnessId, state, note }) => (
          <div key={name} className="flex items-center gap-2.5 px-3 py-2 text-xs">
            <span className="flex size-3 shrink-0 items-center justify-center">
              <StatusGlyph state={state} />
            </span>
            <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
            <span className="shrink-0 text-[0.6875rem] text-muted-foreground">
              {note}
            </span>
            <HarnessLogo harnessId={harnessId} className="size-3 text-muted-foreground" />
          </div>
        ))}
      </div>
    </AppEmbed>
  );
}

// ---------- Commit history, with a working (fake) revert ----------

const t = (key: string, defaultValue: string) =>
  i18n.t(key, { defaultValue });

export function DemoHistory({ width }: { width: number }) {
  const [checkpoints, setCheckpoints] = useState(DEMO_CHECKPOINTS);
  const [reverting, setReverting] = useState<string | null>(null);

  const revert = useCallback(
    (checkpoint: (typeof DEMO_CHECKPOINTS)[number]) => {
      setReverting(checkpoint.id);
      window.setTimeout(() => {
        setCheckpoints((current) => [
          {
            id: `revert-${checkpoint.id}-${current.length}`,
            hash: Math.random().toString(16).slice(2, 9),
            message: `Revert ${checkpoint.hash}`,
            timestamp: new Date(),
          },
          ...current,
        ]);
        setReverting(null);
      }, 900);
    },
    [],
  );

  return (
    <AppEmbed zoom={0.95} width={width} height={250}>
      <div className="flex h-full flex-col overflow-hidden rounded-lg border border-border bg-card py-1 shadow-sm">
        <CheckpointsList
          panelState="ready"
          checkpoints={checkpoints.slice(0, 6)}
          actions={[]}
          message={null}
          isError={false}
          t={t}
          onRevert={revert}
          isReverting={reverting !== null}
          activeRevertId={reverting}
        />
      </div>
    </AppEmbed>
  );
}
