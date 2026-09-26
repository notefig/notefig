import { useRef } from "react";
import { PromptEditor } from "@notefig/widgets";
import { PromptBlobFace } from "@notefig/widgets/prompt/ui/prompt-blob";
import { SuggestionList } from "@notefig/widgets/prompt/composer/mention-menu";
import {
  deriveActiveToolLine,
  deriveLatestAssistantLine,
  deriveTouchedFiles,
  deriveWidgetResponse,
  type BlobPhase,
} from "@notefig/widgets/prompt/state";
import type { AgentEntry, AgentTurn } from "@notefig/shared/agent";
import { FileTypeIcon } from "@/components/editor/file-type-icon";
import { AppEmbed } from "./app-embed";
import { DEMO_FILES, DEMO_ROOT } from "./demo-fixtures";
import { timeline, typed, useDemoClock } from "./use-demo-clock";

/*
 * The inline prompt widget (the app's PromptBlobFace), scripted end to end:
 * the prompt is typed, a file is @-mentioned through the real suggestion
 * popup, and the round goes sending → queued → running → done, with the
 * widget deriving its status line, summary and touched files from the
 * transcript exactly as it does live.
 */

const noop = () => {};

const DOC_PATH = `${DEMO_ROOT}/notes/q3-kickoff.md`;
const ROADMAP_PATH = `${DEMO_ROOT}/notes/roadmap.md`;

const PROMPT_LEAD = "Turn these notes into action items with owners, and add them to ";
const MENTION_QUERY = "ro";
const MENTION_PATH = "notes/roadmap.md";
const PROMPT_TEXT = `${PROMPT_LEAD}@${MENTION_PATH}`;

const ADDED_LINES = [
  "- [ ] Ship onboarding templates (Maya)",
  "- [ ] Pricing page for small teams (Sam)",
  "- [ ] Search beta to all workspaces (Lee)",
];
const REPLY_TEXT =
  "Added three action items with owners to the Q3 section of the roadmap.";

type PromptState = {
  phase: BlobPhase;
  draft: string;
  /** The bound turn's transcript so far. */
  entries: AgentEntry[];
  queueAhead: number;
  /** The "@" query being typed, while the suggestion popup is open. */
  mention: string | null;
};

function toolEntry(
  id: string,
  title: string,
  status: "in_progress" | "completed",
  edit = false,
): AgentEntry {
  const path = edit ? ROADMAP_PATH : DOC_PATH;
  return {
    id,
    taskId: "task_demo",
    turnId: "trn_demo",
    type: "tool_call",
    toolCallId: id,
    toolCall: {
      toolCallId: id,
      title,
      kind: edit ? "edit" : "read",
      status,
      locations: [{ path }],
      ...(edit
        ? {
            content: [
              {
                type: "diff" as const,
                path,
                oldText: "## Q3\n",
                newText: `## Q3\n\n${ADDED_LINES.join("\n")}\n`,
              },
            ],
          }
        : {}),
    },
  };
}

function reply(text: string): AgentEntry {
  return { id: "evt_9", taskId: "task_demo", turnId: "trn_demo", type: "assistant", text };
}

const READ_RUNNING = [toolEntry("evt_1", "Read", "in_progress")];
const EDIT_RUNNING = [
  toolEntry("evt_1", "Read", "completed"),
  toolEntry("evt_2", "Edit", "in_progress", true),
];
const EDIT_DONE = [
  toolEntry("evt_1", "Read", "completed"),
  toolEntry("evt_2", "Edit", "completed", true),
];

function composing(draft: string, mention: string | null = null): PromptState {
  return { phase: "composing", draft, entries: [], queueAhead: 0, mention };
}

function bound(
  phase: BlobPhase,
  entries: AgentEntry[] = [],
  queueAhead = 0,
): PromptState {
  return { phase, draft: "", entries, queueAhead, mention: null };
}

/** Writing the prompt: type, open "@", pick the file. */
const WRITING = [
  { ms: 700, state: () => composing("") },
  {
    ms: PROMPT_LEAD.length * 26,
    state: (ms: number) => composing(typed(PROMPT_LEAD, ms, 26)),
  },
  {
    ms: 1300,
    state: (ms: number) => {
      const query = typed(`@${MENTION_QUERY}`, ms, 110);
      return composing(PROMPT_LEAD + query, query.length > 0 ? query.slice(1) : null);
    },
  },
  { ms: 1400, state: () => composing(`${PROMPT_TEXT} `) },
];

/** The round: sent, waits its turn, works, lands. */
const ROUND = [
  { ms: 600, state: () => ({ ...bound("sending"), draft: `${PROMPT_TEXT} ` }) },
  { ms: 1100, state: () => bound("queued", [], 1) },
  { ms: 1300, state: () => bound("running", READ_RUNNING) },
  { ms: 1200, state: () => bound("running", EDIT_RUNNING) },
  {
    ms: 1300,
    state: (ms: number) =>
      bound("running", [...EDIT_DONE, reply(typed(REPLY_TEXT, ms, 16) || " ")]),
  },
  { ms: 5200, state: () => bound("done", [...EDIT_DONE, reply(REPLY_TEXT)]) },
];

const SCRIPTS = {
  /** The card: summoned over a selection, the prompt written with a mention. */
  summon: timeline<PromptState>(WRITING),
  /** The feature section: the whole round, and what it changed. */
  lifecycle: timeline<PromptState>([...WRITING, ...ROUND]),
};

const RUNNING_TURN: AgentTurn = {
  turnId: "trn_demo",
  taskId: "task_demo",
  sessionId: "ses_demo",
  status: "running",
  startedAt: 0,
};

const TURN_STATUS: Partial<Record<BlobPhase, AgentTurn["status"]>> = {
  queued: "queued",
  running: "running",
  done: "completed",
};

/** The widget's own derivations, run over the state's transcript. */
function displayFor({ phase, entries, queueAhead }: PromptState) {
  const done = phase === "done";
  return {
    touchedFiles: done ? deriveTouchedFiles(entries, DEMO_ROOT) : [],
    widgetResponse: done ? deriveWidgetResponse(entries) : null,
    activeToolLine: phase === "running" ? deriveActiveToolLine(entries) : null,
    assistantTeaser:
      phase === "running" || done ? deriveLatestAssistantLine(entries) : null,
    queueAhead,
  };
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

export function DemoPromptWidget({
  script,
  reference,
  document,
  zoom,
  width,
}: {
  script: keyof typeof SCRIPTS;
  /** The selection the widget was summoned over. */
  reference?: string;
  /** Document text around the widget, as in the editor; its result lands
   *  below it. */
  document?: { heading: string; body: string };
  zoom: number;
  width: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { at, total } = SCRIPTS[script];
  const state = at(useDemoClock(ref, total));
  const face = <PromptFace state={state} reference={reference} />;

  return (
    <div ref={ref} className="w-full min-w-0">
      <AppEmbed zoom={zoom} width={width}>
        {document ? (
          <div className="flex flex-col gap-3">
            {/* The editor's surface: the widget is a node inside the
                document's prose, under the paragraph it was summoned on. */}
            <div className="rounded-xl border border-border bg-background px-2 py-3 shadow-sm">
              <div className="prose prose-sm max-w-none p-4">
                <h2>{document.heading}</h2>
                <p>{document.body}</p>
                <div className="not-prose">{face}</div>
              </div>
            </div>
            {/* Space reserved from the start, so the card never jumps when
                the round lands; the result fades in then. */}
            <div
              key={state.phase === "done" ? "landed" : "pending"}
              className={state.phase === "done" ? "demo-rise" : "invisible"}
            >
              <ResultPeek />
            </div>
          </div>
        ) : (
          face
        )}
      </AppEmbed>
    </div>
  );
}

function PromptFace({
  state,
  reference,
}: {
  state: PromptState;
  reference?: string;
}) {
  const binding = bindingFor(state.phase);
  return (
    <div className="relative">
      <PromptBlobFace
        phase={state.phase}
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
        isSending={state.phase === "sending"}
        display={displayFor(state)}
        draft={state.draft}
        draftIO={{ read: () => state.draft, write: noop, holdsCaret: () => false }}
        draftSlot={<DraftText text={state.draft} />}
        reference={referenceFor(reference)}
        actions={PROMPT_ACTIONS}
      />
      {state.mention !== null && <MentionPopup query={state.mention} />}
    </div>
  );
}

/** The widget's binding for a phase: none while composing, the demo turn
 *  (in the phase's status) from the send on. */
function bindingFor(phase: BlobPhase) {
  if (phase === "composing") {
    return { taskId: null, turnId: null, turn: undefined };
  }
  const status = TURN_STATUS[phase];
  return {
    taskId: "task_demo",
    turnId: "trn_demo",
    turn: status ? { ...RUNNING_TURN, status } : undefined,
  };
}

function referenceFor(text: string | undefined) {
  return text ? { text, from: 0, to: text.length } : null;
}

/** The composer's real "@" suggestion list, open under the draft. */
function MentionPopup({ query }: { query: string }) {
  const items = DEMO_FILES.filter((file) => file.includes(query)).map(
    (relativePath) => ({
      relativePath,
      title: relativePath.split("/").pop() ?? relativePath,
      path: `${DEMO_ROOT}/${relativePath}`,
    }),
  );
  if (items.length === 0) return null;
  return (
    <div className="demo-rise absolute left-9 top-full z-10 -mt-1">
      <SuggestionList
        items={items.slice(0, 4)}
        selectedIndex={0}
        onPick={noop}
        onHover={noop}
      />
    </div>
  );
}

/**
 * The widget's draft is document text (the editor owns it); outside an
 * editor the real composer renders the same string, mention chips included.
 * The draft row owns the padding, type size and placeholder.
 */
function DraftText({ text }: { text: string }) {
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

/** Where the round's work landed: the lines it added to the roadmap. */
function ResultPeek() {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-background text-xs shadow-sm">
      <div className="flex items-center gap-1.5 border-b border-border px-3 py-2 text-muted-foreground">
        <FileTypeIcon path={ROADMAP_PATH} className="size-3.5" />
        <span className="font-medium text-foreground">notes/roadmap.md</span>
        <span className="ms-auto text-success">+{ADDED_LINES.length}</span>
      </div>
      <div className="py-1.5 font-mono text-[0.6875rem] leading-relaxed">
        <div className="px-3 text-muted-foreground">## Q3</div>
        {ADDED_LINES.map((line) => (
          <div key={line} className="bg-success/10 px-3">
            <span className="me-2 text-success">+</span>
            {line}
          </div>
        ))}
      </div>
    </div>
  );
}
