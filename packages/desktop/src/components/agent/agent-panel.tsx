import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useLiveQuery, eq } from "@tanstack/react-db";
import {
  ArrowUp,
  Globe,
  Loader2,
  Mic,
  Plus,
  Sparkles,
  Square,
  Telescope,
} from "lucide-react";
import { BUILT_IN_HARNESSES } from "@metrists/shared/agent";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import { cn } from "@/lib/utils";
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
  agentEventsCollection,
  agentMessagesCollection,
  agentTasksCollection,
  agentTurnsCollection,
  type AgentEvent,
  type AgentMessageRow,
  type AgentTaskRow,
} from "@/agent/agent-collections";
import {
  cancelAgentTask,
  getWorkspaceOverlaps,
  promptAgentTask,
  startAgentTask,
} from "@/agent/agent-service";
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
    try {
      const taskId = await startAgentTask(workspacePath);
      setActiveTaskId(taskId);
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

  const activeTaskRow = sortedTasks.find((t) => t.taskId === activeTaskId);
  const isRunning = activeTaskRow?.status === "running";

  const sendPrompt = useCallback(() => {
    const text = draft.trim();
    if (!activeTaskId || !text) return;
    promptAgentTask(activeTaskId, text);
    setDraft("");
  }, [draft, activeTaskId]);

  const stopTask = useCallback(() => {
    if (!activeTaskId) return;
    void cancelAgentTask(activeTaskId);
  }, [activeTaskId]);

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
        <div className="relative flex min-h-0 flex-1 flex-col">
          <Transcript taskId={activeTaskId} />

          {/* Floating composer pinned to the bottom of the tab. The gradient
              fades the transcript out behind it; the wrapper is click-through
              (pointer-events-none) so only the cards inside catch pointers. */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col gap-2 bg-gradient-to-t from-background via-background/95 to-transparent px-3 pb-3 pt-10">
            {isRunning && (
              <Marker
                role="status"
                className="pointer-events-auto self-start rounded-full border border-border bg-card/80 px-3 py-1 backdrop-blur"
              >
                <MarkerIcon>
                  <Loader2 className="animate-spin" />
                </MarkerIcon>
                <MarkerContent className="shimmer">Working…</MarkerContent>
              </Marker>
            )}
            <div className="pointer-events-auto empty:hidden">
              <PermissionCard taskId={activeTaskId} />
            </div>
            {activeTaskRow?.authHint && (
              <div className="pointer-events-auto rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
                {activeTaskRow.authHint}
              </div>
            )}
            <PromptBox
              value={draft}
              onChange={setDraft}
              onSend={sendPrompt}
              onStop={stopTask}
              isRunning={isRunning}
            />
          </div>
        </div>
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
  const overlaps = getWorkspaceOverlaps(workspacePath);
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
      {/* pb clears the floating composer overlay pinned to the bottom. */}
      <div className="flex flex-col gap-3 p-3 pb-36">
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
    <Marker
      variant="border"
      className="w-full max-w-[85%] py-1.5 text-xs text-foreground"
    >
      <MarkerContent className="font-medium">
        {isEdit ? "✎ " : ""}
        {title}
      </MarkerContent>
      {payload.status && (
        <span className="ms-auto shrink-0 text-muted-foreground">
          {payload.status}
        </span>
      )}
    </Marker>
  );
}

/**
 * The floating composer: a rounded card pinned to the bottom of the tab with
 * the prompt input above a toolbar row. The send control flips to a stop
 * button while the task is streaming (⌘⏎ sends). The left affordances mirror
 * the target design; they are visual placeholders until wired to real actions.
 */
function PromptBox({
  value,
  onChange,
  onSend,
  onStop,
  isRunning,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  isRunning: boolean;
}) {
  const canSend = value.trim().length > 0;
  return (
    <div className="pointer-events-auto rounded-2xl border border-border bg-card shadow-lg shadow-black/5 dark:shadow-black/40">
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            onSend();
          }
        }}
        placeholder="Ask anything, @models, /prompts …"
        rows={2}
        className="max-h-40 min-h-[44px] w-full resize-none bg-transparent px-4 pt-3 text-sm placeholder:text-muted-foreground focus-visible:outline-none"
      />
      <div className="flex items-center gap-1 px-2 pb-2">
        <ComposerIconButton label="Add context">
          <Plus />
        </ComposerIconButton>
        <div className="mx-1 h-5 w-px bg-border" />
        <ComposerIconButton label="Prompts">
          <Sparkles />
        </ComposerIconButton>
        <ComposerIconButton label="Explore">
          <Telescope />
        </ComposerIconButton>
        <ComposerIconButton label="Web search">
          <Globe />
        </ComposerIconButton>

        <div className="ms-auto flex items-center gap-1">
          <ComposerIconButton label="Dictate">
            <Mic />
          </ComposerIconButton>
          {isRunning ? (
            <Button
              size="icon"
              onClick={onStop}
              className="size-9 rounded-xl"
              title="Stop"
              aria-label="Stop"
            >
              <Square className="fill-current" />
            </Button>
          ) : (
            <Button
              size="icon"
              onClick={onSend}
              disabled={!canSend}
              className="size-9 rounded-xl"
              title="Send (⌘⏎)"
              aria-label="Send"
            >
              <ArrowUp />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function ComposerIconButton({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      title={label}
      aria-label={label}
      className={cn("size-8 rounded-lg text-muted-foreground")}
    >
      {children}
    </Button>
  );
}
