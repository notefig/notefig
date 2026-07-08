import { useLiveQuery, eq, and } from "@tanstack/react-db";
import { Button } from "@/components/ui/button";
import { respondToAgentPermission } from "@/agent/agent-service";
import { agentPermissionRequestsCollection } from "@/agent/agent-collections";
import type { PermissionOption } from "@metrists/shared/agent";

/** ACP option kind → button emphasis. Options render verbatim otherwise. */
function variantForKind(
  kind: PermissionOption["kind"],
): "default" | "outline" {
  return kind === "allow_once" || kind === "allow_always"
    ? "default"
    : "outline";
}

/**
 * Renders the head of a task's pending permission queue: the tool-call title
 * and the agent-provided options, verbatim. Reads the queue from
 * agentPermissionRequestsCollection (the one bus); answering settles the
 * promise the ACP client is awaiting via respondToAgentPermission.
 */
export function PermissionCard({ taskId }: { taskId: string }) {
  const { data: pending = [] } = useLiveQuery(
    (q) =>
      q
        .from({ req: agentPermissionRequestsCollection })
        .where(({ req }) =>
          and(eq(req.taskId, taskId), eq(req.status, "pending")),
        ),
    [taskId],
  );
  // Ids sort chronological (taskId_perm_N); render the oldest pending head.
  const head = [...pending].sort((a, b) => (a.id < b.id ? -1 : 1))[0];
  if (!head) return null;

  const options = head.options as PermissionOption[];

  return (
    <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm">
      <div className="mb-2 font-medium">{head.title}</div>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => (
          <Button
            key={option.optionId}
            size="sm"
            variant={variantForKind(option.kind)}
            onClick={() =>
              respondToAgentPermission(taskId, head.id, {
                outcome: { outcome: "selected", optionId: option.optionId },
              })
            }
          >
            {option.name}
          </Button>
        ))}
      </div>
      {pending.length > 1 && (
        <div className="mt-2 text-xs text-muted-foreground">
          {pending.length - 1} more pending
        </div>
      )}
    </div>
  );
}
