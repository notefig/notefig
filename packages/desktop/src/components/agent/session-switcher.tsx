import { Check, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { AgentTaskRow } from "@/agent/agent-collections";
import {
  describeTaskMeta,
  type AgentTaskMeta,
} from "@/hooks/use-agent-tasks";

/**
 * The panel's session picker: a dropdown whose trigger shows the active
 * task's status + title and whose menu lists the workspace's tasks by last
 * activity, each with a status dot and a meta label (running/queued/needs
 * sign-in/failed/time ago) from the shared derivation in use-agent-tasks.
 * Replaces the old horizontal tab strip — it scales past a few sessions
 * without horizontal scrolling.
 */
export function SessionSwitcher({
  tasks,
  activeTaskId,
  onSelect,
}: {
  tasks: AgentTaskMeta[];
  activeTaskId: string | null;
  onSelect: (taskId: string) => void;
}) {
  if (tasks.length === 0) return null;
  const active = tasks.find((meta) => meta.task.taskId === activeTaskId);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="ghost" className="min-w-0 gap-1.5 text-xs">
          {active && <StatusDot status={active.task.status} />}
          <span className="max-w-[180px] truncate">
            {active?.task.title ?? "Sessions"}
          </span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-64">
        {tasks.map((meta) => (
          <DropdownMenuItem
            key={meta.task.taskId}
            onSelect={() => onSelect(meta.task.taskId)}
            className="gap-2 text-xs"
          >
            <StatusDot status={meta.task.status} />
            <span className="max-w-[180px] truncate">{meta.task.title}</span>
            <span className="ms-auto ps-3 text-[11px] text-muted-foreground">
              {describeTaskMeta(meta)}
            </span>
            {meta.task.taskId === activeTaskId && (
              <Check className="size-3.5 shrink-0" />
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function StatusDot({ status }: { status: AgentTaskRow["status"] }) {
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
