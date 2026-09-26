import { createRef, useRef } from "react";
import type { PromptEditorHandle } from "@notefig/widgets";
import type { AgentEntry } from "@notefig/shared/agent";
import { EntryView, PromptBox } from "@/components/agent/agent-chat-tab";
import { AppEmbed } from "./app-embed";
import { DEMO_ROOT, DEMO_TRANSCRIPT } from "./demo-fixtures";
import { streamedMarkdown, typed, useDemoClock } from "./use-demo-clock";

/*
 * An agent session in the app's own chat components (EntryView, PromptBox):
 * the prompt is typed and sent, the plan ticks through, the tool calls run,
 * and the reply streams in — one continuous clock, no frame jumps.
 */

const noop = () => {};

const [USER, PLAN, READ, EDIT, REPLY] = DEMO_TRANSCRIPT;
const USER_TEXT = USER.text ?? "";
const REPLY_TEXT = REPLY.text ?? "";
const TYPE_MS = 22;
const STREAM_MS = 16;

/** The script's beats, in ms from the start of the loop. */
const T = (() => {
  const typedAt = 500 + USER_TEXT.length * TYPE_MS;
  const sent = typedAt + 350;
  const plan = sent + 600;
  const read = plan + 500;
  const readDone = read + 900;
  const edit = readDone + 250;
  const editDone = edit + 1400;
  const reply = editDone + 300;
  const replyDone = reply + REPLY_TEXT.length * STREAM_MS;
  return { typedAt, sent, plan, read, readDone, edit, editDone, reply, replyDone, end: replyDone + 5000 };
})();

type PlanStatus = "pending" | "in_progress" | "completed";

/** Where each plan item is at `ms`: it starts when the previous one lands. */
function planStatus(ms: number, start: number, done: number): PlanStatus {
  if (ms >= done) return "completed";
  return ms >= start ? "in_progress" : "pending";
}

function planAt(ms: number): AgentEntry {
  const entries = (PLAN.plan as { entries: { content: string; priority: string }[] }).entries;
  const beats = [
    [T.plan, T.readDone],
    [T.readDone, T.editDone],
    [T.editDone, T.replyDone],
  ];
  return {
    ...PLAN,
    plan: {
      entries: entries.map((item, i) => ({
        ...item,
        status: planStatus(ms, beats[i][0], beats[i][1]),
      })),
    },
  };
}

function toolAt(entry: AgentEntry, ms: number, done: number): AgentEntry {
  if (!entry.toolCall) return entry;
  const status = ms >= done ? "completed" : "in_progress";
  return { ...entry, toolCall: { ...entry.toolCall, status } };
}

/** Each entry's arrival time, and what it looks like `ms` into the script. */
const BEATS: { at: number; entry: (ms: number) => AgentEntry }[] = [
  { at: T.sent, entry: () => USER },
  { at: T.plan, entry: planAt },
  { at: T.read, entry: (ms) => toolAt(READ, ms, T.readDone) },
  { at: T.edit, entry: (ms) => toolAt(EDIT, ms, T.editDone) },
  {
    at: T.reply,
    entry: (ms) => ({
      ...REPLY,
      text: streamedMarkdown(REPLY_TEXT, ms - T.reply, STREAM_MS) || " ",
    }),
  },
];

/** The transcript as it stands `ms` into the script. */
function entriesAt(ms: number): AgentEntry[] {
  return BEATS.filter((beat) => ms >= beat.at).map((beat) => beat.entry(ms));
}

export function DemoTranscript({
  width,
  height,
}: {
  width: number;
  height: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const ms = useDemoClock(ref, T.end);
  const composerRef = useRef(createRef<PromptEditorHandle>()).current;
  const draft = ms < T.sent ? typed(USER_TEXT, ms - 500, TYPE_MS) : "";
  const running = ms >= T.sent && ms < T.replyDone;

  return (
    <div ref={ref} className="w-full min-w-0">
      <AppEmbed zoom={0.8} width={width} height={height} className="flex flex-col">
        <div className="flex min-h-0 flex-1 flex-col justify-end gap-3 overflow-hidden px-1 pb-4 [mask-image:linear-gradient(transparent,black_18%)]">
          {entriesAt(ms).map((entry) => (
            <div key={entry.id} className="demo-rise">
              <EntryView entry={entry} />
            </div>
          ))}
        </div>
        <PromptBox
          value={draft}
          onChange={noop}
          onSend={noop}
          onStop={noop}
          onCancelRestore={noop}
          isRunning={running}
          taskId="task_c"
          harnessId="claude-code"
          workspacePath={DEMO_ROOT}
          composerRef={composerRef}
        />
      </AppEmbed>
    </div>
  );
}
