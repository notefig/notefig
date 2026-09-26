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

const PROMPT_LEAD = "Turn these notes into action items with owners, using ";
const MENTION_QUERY = "ro";
const MENTION_PATH = "notes/roadmap.md";
const PROMPT_TAIL = " for priorities";
const PROMPT_TEXT = `${PROMPT_LEAD}@${MENTION_PATH}${PROMPT_TAIL}`;

/** What the round writes into the document, under the widget. */
export const ACTION_ITEMS = [
  { task: "Ship onboarding templates", owner: "Maya" },
  { task: "Pricing page for small teams", owner: "Sam" },
  { task: "Search beta to all workspaces", owner: "Lee" },
];
const ADDED_MARKDOWN = `## Action items\n\n${ACTION_ITEMS.map(
  (item) => `- [ ] ${item.task} (${item.owner})`,
).join("\n")}\n`;
const REPLY_TEXT =
  "Added three action items with owners, ordered by the roadmap's Q3 priorities.";

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
  // Reads the mentioned roadmap, then writes into this document.
  const path = edit ? DOC_PATH : ROADMAP_PATH;
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
                oldText: "",
                newText: ADDED_MARKDOWN,
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
  {
    ms: 700 + PROMPT_TAIL.length * 26,
    state: (ms: number) =>
      composing(
        `${PROMPT_LEAD}@${MENTION_PATH}${typed(PROMPT_TAIL, ms - 700, 26)}`,
      ),
  },
  { ms: 1200, state: () => composing(PROMPT_TEXT) },
];

/** The round: sent, waits its turn, works, lands. */
const ROUND = [
  { ms: 600, state: () => ({ ...bound("sending"), draft: PROMPT_TEXT }) },
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
  height,
}: {
  script: keyof typeof SCRIPTS;
  /** The selection the widget was summoned over. */
  reference?: string;
  /** Show the widget in a document page, where the round's result lands. */
  document?: { heading: string; body: string };
  zoom: number;
  width: number;
  /** A document page's fixed height, so nothing moves as the round runs. */
  height?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { at, total } = SCRIPTS[script];
  const state = at(useDemoClock(ref, total));
  const face = <PromptFace state={state} reference={reference} />;

  return (
    <div ref={ref} className="w-full min-w-0">
      <AppEmbed zoom={zoom} width={width} height={height}>
        {document ? (
          <DocumentPage document={document} landed={state.phase === "done"}>
            {face}
          </DocumentPage>
        ) : (
          face
        )}
      </AppEmbed>
    </div>
  );
}

/**
 * The editor's surface at a fixed height: the widget is a node inside the
 * document's prose, under the paragraph it was summoned on, and the round's
 * result is written into the same page below it — the empty page below
 * absorbs every change in height.
 */
function DocumentPage({
  document,
  landed,
  children,
}: {
  document: { heading: string; body: string };
  landed: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="h-full overflow-hidden rounded-xl border border-border bg-background px-2 py-3 shadow-sm">
      <div className="prose prose-sm max-w-none p-4">
        <h2>{document.heading}</h2>
        <p>{document.body}</p>
        <div className="not-prose">{children}</div>
        {landed && (
          <div className="demo-land -mx-2 mt-4 rounded-lg px-2 pb-1">
            <h3 className="mt-2">Action items</h3>
            <ul className="contains-task-list">
              {ACTION_ITEMS.map((item) => (
                <li key={item.task}>
                  {item.task} <span className="text-muted-foreground">({item.owner})</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
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
