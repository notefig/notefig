import { useRef } from "react";
import { PromptEditor } from "@notefig/widgets";
import { PromptBlobFace } from "@notefig/widgets/prompt/ui/prompt-blob";
import type { PromptChangeNavigation } from "@notefig/widgets/prompt/change-navigator";
import { SuggestionList } from "@notefig/widgets/prompt/composer/mention-menu";
import {
  deriveActiveToolLine,
  deriveLatestAssistantLine,
  deriveTouchedFiles,
  deriveWidgetResponse,
  type BlobPhase,
} from "@notefig/widgets/prompt/state";
import type { AgentEntry, AgentTurn } from "@notefig/shared/agent";
import { HarnessLogo } from "@notefig/ui/harness-logo";
import { AppEmbed } from "./app-embed";
import { DEMO_FILES, DEMO_ROOT } from "./demo-fixtures";
import { AgentHost } from "./demo-host";
import { timeline, typed, useDemoClock } from "./use-demo-clock";

/*
 * The inline prompt widget (the app's PromptBlobFace), scripted end to end.
 * The card version writes one prompt with an @-mention. The document version
 * puts two agents in one page: Claude Code turns the notes into action
 * items while OpenCode, summoned further down, writes the team summary.
 * Both run at once, and each one's edit streams into its own part of the
 * page. Every widget derives its status line, summary and touched files
 * from its transcript, as it does live.
 */

const noop = () => {};

const DOC_PATH = `${DEMO_ROOT}/notes/q3-kickoff.md`;
const ROADMAP_PATH = `${DEMO_ROOT}/notes/roadmap.md`;
const TYPE_MS = 24;

type PromptState = {
  phase: BlobPhase;
  draft: string;
  /** The bound turn's transcript so far. */
  entries: AgentEntry[];
  queueAhead: number;
  /** The "@" query being typed, while the suggestion popup is open. */
  mention: string | null;
  /** How much of the round's edit has been written into the page, 0 to 1. */
  written: number;
};

function composing(draft: string, mention: string | null = null): PromptState {
  return {
    phase: "composing",
    draft,
    entries: [],
    queueAhead: 0,
    mention,
    written: 0,
  };
}

function bound(
  phase: BlobPhase,
  entries: AgentEntry[] = [],
  written = 0,
): PromptState {
  return { phase, draft: "", entries, queueAhead: 0, mention: null, written };
}

function toolEntry(
  id: string,
  title: string,
  status: "in_progress" | "completed",
  path: string,
  newText?: string,
): AgentEntry {
  return {
    id,
    taskId: "task_demo",
    turnId: "trn_demo",
    type: "tool_call",
    toolCallId: id,
    toolCall: {
      toolCallId: id,
      title,
      kind: newText === undefined ? "read" : "edit",
      status,
      locations: [{ path }],
      ...(newText === undefined
        ? {}
        : { content: [{ type: "diff" as const, path, oldText: "", newText }] }),
    },
  };
}

function reply(text: string): AgentEntry {
  return {
    id: "evt_9",
    taskId: "task_demo",
    turnId: "trn_demo",
    type: "assistant",
    text,
  };
}

/**
 * One agent's round after the send: it reads, writes into the page (the
 * edit streams in), replies, and lands.
 */
function round({
  read,
  edit,
  replyText,
  readMs,
  editMs,
}: {
  read: string;
  edit: string;
  replyText: string;
  readMs: number;
  editMs: number;
}) {
  const reading = [toolEntry("evt_1", "Read", "in_progress", read)];
  const editing = [
    toolEntry("evt_1", "Read", "completed", read),
    toolEntry("evt_2", "Edit", "in_progress", DOC_PATH, edit),
  ];
  const edited = [
    toolEntry("evt_1", "Read", "completed", read),
    toolEntry("evt_2", "Edit", "completed", DOC_PATH, edit),
  ];
  return [
    { ms: 500, state: () => bound("sending") },
    { ms: readMs, state: () => bound("running", reading) },
    {
      ms: editMs,
      state: (ms: number) => bound("running", editing, ms / editMs),
    },
    {
      ms: 900,
      state: (ms: number) =>
        bound(
          "running",
          [...edited, reply(typed(replyText, ms, 14) || " ")],
          1,
        ),
    },
    { ms: 1, state: () => bound("done", [...edited, reply(replyText)], 1) },
  ];
}

// ---------- Claude Code: action items, with an @-mention ----------

const PROMPT_LEAD = "Turn these notes into action items with owners, using ";
const MENTION_QUERY = "ro";
const MENTION_PATH = "notes/roadmap.md";
const PROMPT_TAIL = " for priorities";
const PROMPT_TEXT = `${PROMPT_LEAD}@${MENTION_PATH}${PROMPT_TAIL}`;

export const ACTION_ITEMS = [
  { task: "Ship onboarding templates", owner: "Maya" },
  { task: "Pricing page for small teams", owner: "Sam" },
  { task: "Search beta to all workspaces", owner: "Lee" },
];

/** Writing the prompt: type, open "@", pick the file, finish the sentence. */
const WRITING = [
  { ms: 700, state: () => composing("") },
  {
    ms: PROMPT_LEAD.length * TYPE_MS,
    state: (ms: number) => composing(typed(PROMPT_LEAD, ms, TYPE_MS)),
  },
  {
    ms: 1300,
    state: (ms: number) => {
      const query = typed(`@${MENTION_QUERY}`, ms, 110);
      return composing(
        PROMPT_LEAD + query,
        query.length > 0 ? query.slice(1) : null,
      );
    },
  },
  {
    ms: 600 + PROMPT_TAIL.length * TYPE_MS,
    state: (ms: number) =>
      composing(
        `${PROMPT_LEAD}@${MENTION_PATH}${typed(PROMPT_TAIL, ms - 600, TYPE_MS)}`,
      ),
  },
  { ms: 500, state: () => composing(PROMPT_TEXT) },
];

const CLAUDE_TRACK = timeline<PromptState>([
  ...WRITING,
  ...round({
    read: ROADMAP_PATH,
    edit: ACTION_ITEMS.map((item) => `- [ ] ${item.task} (${item.owner})`).join(
      "\n",
    ),
    replyText: "Added three action items with owners, ordered by the roadmap.",
    readMs: 1100,
    editMs: 2600,
  }),
]);

// ---------- OpenCode: the team summary, summoned while Claude works ----------

const SUMMARY_PROMPT = "Summarize this for the team channel in two lines";
export const SUMMARY_TEXT =
  "Templates ship first, then small-team pricing. Search goes to every workspace in beta before the offsite.";

const OPENCODE_TRACK = timeline<PromptState>([
  { ms: 500, state: () => composing("") },
  {
    ms: SUMMARY_PROMPT.length * TYPE_MS,
    state: (ms: number) => composing(typed(SUMMARY_PROMPT, ms, TYPE_MS)),
  },
  { ms: 300, state: () => composing(SUMMARY_PROMPT) },
  ...round({
    read: DOC_PATH,
    edit: SUMMARY_TEXT,
    replyText: "Wrote a two-line summary for the team channel.",
    readMs: 900,
    editMs: 2200,
  }),
]);

/** OpenCode is summoned once Claude's prompt is on its way. */
const OPENCODE_START =
  WRITING.reduce((sum, segment) => sum + segment.ms, 0) + 500;
const HOLD_MS = 4500;
const COLLAB_TOTAL =
  Math.max(CLAUDE_TRACK.total, OPENCODE_START + OPENCODE_TRACK.total) + HOLD_MS;

/** The card: summoned over a selection, the prompt written with a mention. */
const SUMMON = timeline<PromptState>(WRITING);

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
/** The demo's turn writes nothing for real, so it has no changes to
 *  review: each touched file's chip just opens it. */
const NO_CHANGES: PromptChangeNavigation = {
  count: 0,
  reviewing: false,
  color: "",
  toggleReview: noop,
  showChanges: noop,
  index: null,
  step: noop,
};

function displayFor({ phase, entries, queueAhead }: PromptState) {
  const done = phase === "done";
  return {
    touchedFiles: done ? deriveTouchedFiles(entries, DEMO_ROOT) : [],
    widgetResponse: done ? deriveWidgetResponse(entries) : null,
    activeToolLine: phase === "running" ? deriveActiveToolLine(entries) : null,
    assistantTeaser:
      phase === "running" || done ? deriveLatestAssistantLine(entries) : null,
    queueAhead,
    changeCounts: new Map<string, number>(),
    changes: NO_CHANGES,
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

/** The card: one widget, summoned over a selection, writing a prompt. */
export function DemoPromptWidget({
  reference,
  zoom,
  width,
}: {
  reference: string;
  zoom: number;
  width: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const state = SUMMON.at(useDemoClock(ref, SUMMON.total));
  return (
    <div ref={ref} className="w-full min-w-0">
      <AppEmbed zoom={zoom} width={width}>
        <PromptFace state={state} prompt={PROMPT_TEXT} reference={reference} />
      </AppEmbed>
    </div>
  );
}

/**
 * The feature section: one document, two agents working in it at once with
 * the user. A fixed-height page, so the empty page below absorbs every
 * change in height and nothing moves.
 */
export function DemoCollaboration({
  document,
  zoom,
  width,
  height,
}: {
  document: { heading: string; body: string };
  zoom: number;
  width: number;
  height: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const ms = useDemoClock(ref, COLLAB_TOTAL);
  const claude = CLAUDE_TRACK.at(ms);
  const opencode =
    ms >= OPENCODE_START ? OPENCODE_TRACK.at(ms - OPENCODE_START) : null;

  return (
    <div ref={ref} className="w-full min-w-0">
      <AppEmbed zoom={zoom} width={width} height={height}>
        <div className="h-full overflow-hidden rounded-xl border border-border bg-background px-2 py-3 shadow-sm">
          <div className="prose prose-sm max-w-none p-4">
            <h2>{document.heading}</h2>
            <p>{document.body}</p>
            <AgentWidget
              harnessId="claude-code"
              label="Claude Code"
              state={claude}
              prompt={PROMPT_TEXT}
            />
            <ActionItems written={claude.written} />
            <h3>For the team channel</h3>
            {opencode && (
              <AgentWidget
                harnessId="opencode"
                label="OpenCode"
                state={opencode}
                prompt={SUMMARY_PROMPT}
              />
            )}
            <Summary written={opencode?.written ?? 0} />
          </div>
        </div>
      </AppEmbed>
    </div>
  );
}

/** One agent's widget in the page, under its presence tag. */
function AgentWidget({
  harnessId,
  label,
  state,
  prompt,
}: {
  harnessId: string;
  label: string;
  state: PromptState;
  prompt: string;
}) {
  return (
    <div className="not-prose demo-rise my-3">
      <p className="mb-1 flex items-center gap-1.5 text-[0.6875rem] font-medium text-muted-foreground">
        <HarnessLogo harnessId={harnessId} className="size-3" />
        {label}
      </p>
      <AgentHost harnessId={harnessId}>
        <PromptFace state={state} prompt={prompt} />
      </AgentHost>
    </div>
  );
}

/** Claude's edit, streaming into the page item by item. */
function ActionItems({ written }: { written: number }) {
  if (written <= 0) return null;
  const shown = Math.ceil(written * ACTION_ITEMS.length);
  return (
    <div className="demo-land -mx-2 rounded-lg px-2 pb-1">
      <h3 className="mt-1">Action items</h3>
      <ul>
        {ACTION_ITEMS.slice(0, shown).map((item) => (
          <li key={item.task} className="demo-rise">
            {item.task}{" "}
            <span className="text-muted-foreground">({item.owner})</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** OpenCode's edit, streaming into the page as it writes. */
function Summary({ written }: { written: number }) {
  if (written <= 0) return null;
  const text = SUMMARY_TEXT.slice(0, Math.ceil(written * SUMMARY_TEXT.length));
  return <p className="demo-land -mx-2 rounded-lg px-2">{text}</p>;
}

function PromptFace({
  state,
  prompt,
  reference,
}: {
  state: PromptState;
  prompt: string;
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
          lastSentPrompt: prompt,
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
        draft={sendingDraft(state, prompt)}
        draftIO={{
          read: () => state.draft,
          write: noop,
          holdsCaret: () => false,
        }}
        draftSlot={<DraftText text={state.draft} />}
        reference={referenceFor(reference)}
        actions={PROMPT_ACTIONS}
      />
      {state.mention !== null && <MentionPopup query={state.mention} />}
    </div>
  );
}

/** The sending row shows the prompt it is sending. */
function sendingDraft(state: PromptState, prompt: string): string {
  return state.phase === "sending" ? prompt : state.draft;
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
