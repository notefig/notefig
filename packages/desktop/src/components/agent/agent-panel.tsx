import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery, eq } from "@tanstack/react-db";
import { BUILT_IN_HARNESSES } from "@metrists/shared/agent";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useKv } from "@/utils/kv-store";
import { normalizePath } from "@/utils/fs";
import {
  agentDiagnosticsCollection,
  agentEventsCollection,
  agentMessagesCollection,
  agentTasksCollection,
  agentTurnsCollection,
  type AgentDiagnosticRow,
  type AgentEvent,
  type AgentMessageRow,
  type AgentTaskRow,
} from "@/agent/agent-collections";
import {
  getOrCreateWorkspaceTaskManager,
  getWorkspaceTaskManager,
} from "@/agent/agent-service";
import { isAgentDebugEnabled } from "@/agent/agent-trace";
import { TauriStdioTransport } from "@/agent/tauri-stdio-transport";
import { PermissionCard } from "./permission-card";

/**
 * The agent panel: a task list (create/switch/cancel — parallel tasks are
 * first-class), and per selected task a prompt input, streamed turn output
 * (message chunks coalesced per turn), inline tool-call cards, and that task's
 * permission queue. Reads the task-keyed collections via useLiveQuery and
 * talks to the workspace's TaskManager. Overlap warnings ("two tasks are
 * editing pricing.md") surface from TaskManager.writeGate.getOverlappingPaths.
 */
export type AgentPanelProps = {
  workspacePath: string;
};

export function AgentPanel({ workspacePath }: AgentPanelProps) {
  const normalized = normalizePath(workspacePath);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [trustPromptOpen, setTrustPromptOpen] = useState(false);
  const kv = useKv<boolean>("agent");
  const trustKey = `trust:${normalized}`;

  const { data: tasks = [] } = useLiveQuery(
    (q) =>
      q
        .from({ task: agentTasksCollection })
        .where(({ task }) => eq(task.workspacePath, normalized)),
    [normalized],
  );
  // Newest-first (task ids sort descending by construction).
  const sortedTasks = useMemo(
    () => [...tasks].sort((a, b) => (a.taskId < b.taskId ? -1 : 1)),
    [tasks],
  );

  // Default the selection to the newest task.
  useEffect(() => {
    if (!activeTaskId && sortedTasks.length > 0) {
      setActiveTaskId(sortedTasks[0].taskId);
    }
  }, [activeTaskId, sortedTasks]);

  const startTask = useCallback(async () => {
    const harness = BUILT_IN_HARNESSES[0];
    const manager = getOrCreateWorkspaceTaskManager(workspacePath);
    const task = manager.createTask(harness);
    setActiveTaskId(task.taskId);
    const transport = new TauriStdioTransport({
      procId: task.taskId,
      program: harness.command,
      args: harness.args,
      cwd: workspacePath,
      env: harness.env,
    });
    try {
      await task.start(transport);
    } catch (error) {
      console.error("Failed to start agent task:", error);
    }
  }, [workspacePath]);

  const handleCreate = useCallback(() => {
    if (kv.get(trustKey)) {
      void startTask();
    } else {
      setTrustPromptOpen(true);
    }
  }, [kv, trustKey, startTask]);

  const confirmTrust = useCallback(() => {
    kv.set(trustKey, true);
    setTrustPromptOpen(false);
    void startTask();
  }, [kv, trustKey, startTask]);

  const activeTask = activeTaskId
    ? getWorkspaceTaskManager(workspacePath)?.getTask(activeTaskId)
    : undefined;
  const activeTaskRow = sortedTasks.find((t) => t.taskId === activeTaskId);
  const [showRaw, setShowRaw] = useState(false);
  const debugEnabled = isAgentDebugEnabled();

  const sendPrompt = useCallback(() => {
    const text = draft.trim();
    if (!activeTaskId || !text) return;
    const task = getWorkspaceTaskManager(workspacePath)?.getTask(activeTaskId);
    void task?.prompt(text);
    setDraft("");
  }, [draft, activeTaskId, workspacePath]);

  const stopTask = useCallback(() => {
    if (!activeTaskId) return;
    void getWorkspaceTaskManager(workspacePath)?.getTask(activeTaskId)?.cancel();
  }, [activeTaskId, workspacePath]);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden border-s border-border bg-background">
      <TaskList
        tasks={sortedTasks}
        activeTaskId={activeTaskId}
        onSelect={setActiveTaskId}
        onCreate={handleCreate}
      />

      <OverlapBanner workspacePath={workspacePath} tick={tasks.length} />

      {activeTaskId ? (
        <>
          {debugEnabled && (
            <div className="flex items-center gap-2 border-b border-border px-3 py-1 text-xs">
              <button
                onClick={() => setShowRaw(false)}
                className={!showRaw ? "font-medium" : "text-muted-foreground"}
              >
                Chat
              </button>
              <button
                onClick={() => setShowRaw(true)}
                className={showRaw ? "font-medium" : "text-muted-foreground"}
              >
                Raw
              </button>
            </div>
          )}
          {showRaw ? (
            <DiagnosticsView taskId={activeTaskId} />
          ) : (
            <Transcript taskId={activeTaskId} />
          )}
          {activeTask && (
            <div className="px-3">
              <PermissionCard broker={activeTask.permissionBroker} />
            </div>
          )}
          {activeTaskRow?.authHint && (
            <div className="mx-3 mb-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
              {activeTaskRow.authHint}
            </div>
          )}
          <PromptBox
            value={draft}
            onChange={setDraft}
            onSend={sendPrompt}
            onStop={stopTask}
          />
        </>
      ) : (
        <div className="flex flex-1 items-center justify-center p-4 text-center text-sm text-muted-foreground">
          Start a task to chat with an agent about your documents.
        </div>
      )}

      <AlertDialog open={trustPromptOpen} onOpenChange={setTrustPromptOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Run an agent in this workspace?</AlertDialogTitle>
            <AlertDialogDescription>
              This spawns {BUILT_IN_HARNESSES[0].label} as a local process with
              access to the files in this folder. Only continue for workspaces
              you trust.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmTrust}>
              Trust &amp; start
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function TaskList({
  tasks,
  activeTaskId,
  onSelect,
  onCreate,
}: {
  tasks: AgentTaskRow[];
  activeTaskId: string | null;
  onSelect: (taskId: string) => void;
  onCreate: () => void;
}) {
  return (
    <div className="flex items-center gap-2 overflow-x-auto border-b border-border p-2">
      <Button size="sm" variant="outline" onClick={onCreate}>
        + New task
      </Button>
      {tasks.map((task) => (
        <button
          key={task.taskId}
          onClick={() => onSelect(task.taskId)}
          className={`flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1 text-xs ${
            task.taskId === activeTaskId
              ? "bg-accent text-accent-foreground"
              : "hover:bg-muted"
          }`}
          title={task.title}
        >
          <StatusDot status={task.status} />
          <span className="max-w-[140px] truncate">{task.title}</span>
        </button>
      ))}
    </div>
  );
}

function StatusDot({ status }: { status: AgentTaskRow["status"] }) {
  const color =
    status === "running"
      ? "bg-blue-500 animate-pulse"
      : status === "error"
        ? "bg-red-500"
        : status === "idle"
          ? "bg-green-500"
          : status === "cancelled"
            ? "bg-muted-foreground"
            : "bg-amber-500";
  return <span className={`h-2 w-2 shrink-0 rounded-full ${color}`} />;
}

function OverlapBanner({
  workspacePath,
  tick,
}: {
  workspacePath: string;
  // Re-evaluate when tasks change; overlap is imperative (write-gate state).
  tick: number;
}) {
  const overlaps =
    getWorkspaceTaskManager(workspacePath)?.writeGate.getOverlappingPaths() ??
    [];
  void tick;
  if (overlaps.length === 0) return null;
  return (
    <div className="border-b border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs">
      {overlaps.map((o) => (
        <div key={o.path}>
          {o.taskIds.length} tasks are editing{" "}
          <code>{o.path.split("/").pop()}</code>
        </div>
      ))}
    </div>
  );
}

function Transcript({ taskId }: { taskId: string }) {
  const bottomRef = useRef<HTMLDivElement>(null);

  const { data: messages = [] } = useLiveQuery(
    (q) =>
      q
        .from({ message: agentMessagesCollection })
        .where(({ message }) => eq(message.taskId, taskId)),
    [taskId],
  );
  const { data: events = [] } = useLiveQuery(
    (q) =>
      q
        .from({ event: agentEventsCollection })
        .where(({ event }) => eq(event.taskId, taskId)),
    [taskId],
  );
  const { data: turns = [] } = useLiveQuery(
    (q) =>
      q
        .from({ turn: agentTurnsCollection })
        .where(({ turn }) => eq(turn.taskId, taskId)),
    [taskId],
  );
  const turnErrors = useMemo(
    () => turns.filter((t) => t.status === "error" && t.error),
    [turns],
  );

  const eventsByMessage = useMemo(() => {
    const map = new Map<string, AgentEvent[]>();
    for (const event of events) {
      const list = map.get(event.messageId) ?? [];
      list.push(event);
      map.set(event.messageId, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => (a.id < b.id ? -1 : 1));
    }
    return map;
  }, [events]);

  const sortedMessages = useMemo(
    () =>
      [...messages].sort((a, b) => (a.messageId < b.messageId ? -1 : 1)),
    [messages],
  );

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [events, messages]);

  return (
    <ScrollArea className="flex-1 min-h-0">
      <div className="flex flex-col gap-3 p-3">
        {sortedMessages.map((message) => (
          <MessageView
            key={message.messageId}
            message={message}
            events={eventsByMessage.get(message.messageId) ?? []}
          />
        ))}
        {turnErrors.map((turn) => (
          <div
            key={turn.turnId}
            className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400"
          >
            <span className="font-medium">Turn failed:</span> {turn.error}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </ScrollArea>
  );
}

/**
 * Dev-only "Raw" view: the task's diagnostics stream (stderr, raw ACP frames
 * both directions, turn/exit errors, spawn context, unrendered updates). The
 * inspectable harness-side truth the transcript doesn't show.
 */
function DiagnosticsView({ taskId }: { taskId: string }) {
  const { data: rows = [] } = useLiveQuery(
    (q) =>
      q
        .from({ row: agentDiagnosticsCollection })
        .where(({ row }) => eq(row.taskId, taskId)),
    [taskId],
  );
  const sorted = useMemo(
    () => [...rows].sort((a, b) => (a.id < b.id ? -1 : 1)),
    [rows],
  );

  const kindColor = (kind: AgentDiagnosticRow["kind"]) =>
    kind === "frame_out"
      ? "text-blue-500"
      : kind === "frame_in"
        ? "text-green-600 dark:text-green-400"
        : kind === "stderr"
          ? "text-amber-600 dark:text-amber-400"
          : kind === "turn_error" || kind === "exit"
            ? "text-red-500"
            : "text-muted-foreground";

  return (
    <ScrollArea className="flex-1 min-h-0">
      <div className="flex flex-col gap-0.5 p-2 font-mono text-[11px] leading-tight">
        {sorted.map((row) => (
          <div key={row.id} className="whitespace-pre-wrap break-all">
            <span className={kindColor(row.kind)}>{row.kind}</span>{" "}
            <span className="text-foreground/80">
              {typeof row.payload === "string"
                ? row.payload
                : JSON.stringify(row.payload)}
            </span>
          </div>
        ))}
        {sorted.length === 0 && (
          <div className="p-2 text-muted-foreground">No diagnostics yet.</div>
        )}
      </div>
    </ScrollArea>
  );
}

function messageText(events: AgentEvent[]): string {
  return events
    .filter((event) => event.kind === "message_chunk")
    .map((event) => {
      const payload = event.payload as { text?: string } | undefined;
      return payload?.text ?? "";
    })
    .join("");
}

function MessageView({
  message,
  events,
}: {
  message: AgentMessageRow;
  events: AgentEvent[];
}) {
  const text = messageText(events);
  const toolEvents = events.filter(
    (event) =>
      event.kind === "tool_call" || event.kind === "tool_call_update",
  );
  const isUser = message.role === "user";

  return (
    <div className={`flex flex-col gap-1 ${isUser ? "items-end" : "items-start"}`}>
      {text && (
        <div
          className={`max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
            isUser
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-foreground"
          }`}
        >
          {text}
        </div>
      )}
      {toolEvents.map((event) => (
        <ToolCallCard key={event.id} event={event} />
      ))}
    </div>
  );
}

function ToolCallCard({ event }: { event: AgentEvent }) {
  const payload = event.payload as {
    title?: string | null;
    kind?: string | null;
    status?: string | null;
  };
  const title = payload.title ?? "Tool call";
  const isEdit = payload.kind === "edit";
  return (
    <div className="w-full max-w-[85%] rounded-md border border-border bg-card px-3 py-1.5 text-xs">
      <span className="font-medium">
        {isEdit ? "✎ " : ""}
        {title}
      </span>
      {payload.status && (
        <span className="ms-2 text-muted-foreground">{payload.status}</span>
      )}
    </div>
  );
}

function PromptBox({
  value,
  onChange,
  onSend,
  onStop,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
}) {
  return (
    <div className="flex items-end gap-2 border-t border-border p-2">
      <Textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            onSend();
          }
        }}
        placeholder="Ask the agent to edit your docs… (⌘⏎ to send)"
        className="min-h-[38px] flex-1 resize-none"
        rows={2}
      />
      <div className="flex flex-col gap-1">
        <Button size="sm" onClick={onSend} disabled={!value.trim()}>
          Send
        </Button>
        <Button size="sm" variant="ghost" onClick={onStop}>
          Stop
        </Button>
      </div>
    </div>
  );
}
