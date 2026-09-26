import type {
  AgentEntry,
  AgentTaskRow,
  ToolCallUpdate,
} from "@notefig/shared/agent";

/*
 * The fake workspace the demos describe. Plain data in the app's own row
 * shapes (AgentTaskRow, AgentEntry, …) so the real components render it
 * exactly as they would a live session.
 */

/** The live demo's workspace (content-manifest WORKSPACE_ROOT), so the
 *  files these demos name are files a visitor can open in the app above. */
export const DEMO_ROOT = "notefig";

export const DEMO_FILES = [
  "notes/q3-kickoff.md",
  "notes/roadmap.md",
  "notes/insights.md",
  "notes/interviews/acme.md",
  "notes/interviews/globex.md",
];

const now = Date.now();
const minutes = (count: number) => now - count * 60_000;

function task(
  taskId: string,
  title: string,
  status: AgentTaskRow["status"],
  harnessId: string,
  updatedAt: number,
): AgentTaskRow {
  return {
    taskId,
    workspacePath: DEMO_ROOT,
    title,
    status,
    harnessId,
    createdAt: updatedAt,
    updatedAt,
  };
}

/** The sessions list: one working, one finished, one older. */
export const DEMO_SESSIONS = [
  {
    task: task("task_c", "Summarize this week's customer interviews", "running", "claude-code", minutes(1)),
    meta: { isRunning: true, queuedCount: 1 },
  },
  {
    task: task("task_b", "Draft the Q3 planning doc", "idle", "opencode", minutes(12)),
    meta: { isRunning: false, queuedCount: 0 },
    attention: "bau" as const,
  },
  {
    task: task("task_d", "Research competitor pricing", "idle", "claude-code", minutes(3)),
    meta: { isRunning: false, queuedCount: 1 },
  },
  {
    task: task("task_e", "Clean up the team handbook", "error", "opencode", minutes(40)),
    meta: { isRunning: false, queuedCount: 0, isError: true },
    attention: "error" as const,
  },
  {
    task: task("task_a", "Turn meeting notes into action items", "idle", "claude-code", minutes(95)),
    meta: { isRunning: false, queuedCount: 0 },
  },
];

let seq = 0;
function entry(
  type: AgentEntry["type"],
  fields: Partial<AgentEntry>,
): AgentEntry {
  seq += 1;
  return {
    id: `evt_${String(seq).padStart(4, "0")}`,
    taskId: "task_c",
    turnId: "trn_1",
    type,
    ...fields,
  };
}

function tool(fields: ToolCallUpdate): AgentEntry {
  return entry("tool_call", { toolCallId: fields.toolCallId, toolCall: fields });
}

const INSIGHTS_BEFORE = `# Customer insights

_Nothing yet._`;

const INSIGHTS_AFTER = `# Customer insights

## Top themes this week

1. **Onboarding takes too long.** 4 of 6 teams asked for templates.
2. **Search is the killer feature.** Mentioned unprompted in every call.
3. **Pricing is unclear for small teams.**

Sources: [Acme](interviews/acme.md), [Globex](interviews/globex.md)`;

/**
 * A realistic turn, in render order. The transcript demo reveals it entry by
 * entry; the tool calls flip from in-flight to completed as it goes.
 */
export const DEMO_TRANSCRIPT: AgentEntry[] = [
  entry("user", {
    text: "Summarize this week's customer interviews into @notes/insights.md: top three themes, with sources.",
  }),
  entry("plan", {
    plan: {
      entries: [
        { content: "Read this week's interview notes", status: "completed", priority: "high" },
        { content: "Group feedback into themes", status: "completed", priority: "high" },
        { content: "Write notes/insights.md with sources", status: "completed", priority: "medium" },
      ],
    },
  }),
  tool({
    toolCallId: "call_read",
    title: "Read",
    kind: "read",
    status: "completed",
    locations: [{ path: "notes/interviews/" }],
  }),
  tool({
    toolCallId: "call_edit",
    title: "Edit",
    kind: "edit",
    status: "completed",
    content: [
      {
        type: "diff",
        path: "notes/insights.md",
        oldText: INSIGHTS_BEFORE,
        newText: INSIGHTS_AFTER,
      },
    ],
  }),
  entry("assistant", {
    text: "Done. **Three themes** from six interviews: onboarding friction, search, and small-team pricing. Each one links back to its [source notes](interviews/).",
  }),
];

/** The commit history panel's rows (newest first, as the app lists them). */
export const DEMO_CHECKPOINTS = [
  { id: "c5", hash: "a41f9c2", message: "Summarize customer interviews", timestamp: new Date(minutes(2)) },
  { id: "c4", hash: "7be0d13", message: "Edit roadmap.md", timestamp: new Date(minutes(14)) },
  { id: "c3", hash: "3f02a9e", message: "Draft the Q3 plan", timestamp: new Date(minutes(62)) },
  { id: "c2", hash: "c9d71b4", message: "Action items from kickoff", timestamp: new Date(minutes(180)) },
  { id: "c1", hash: "58e6d0a", message: "Initial notes", timestamp: new Date(minutes(1440)) },
];
