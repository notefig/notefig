import { useLiveQuery, eq, and } from "@tanstack/react-db";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
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
export function PermissionCard({
  taskId,
  bare = false,
}: {
  taskId: string;
  /** Skip the card's own border/bg/padding — for hosts (the prompt-blob
   *  widget) that already wrap it in an equivalently-tinted container. */
  bare?: boolean;
}) {
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
    <div
      className={cn(
        "text-sm",
        // Muted tint over an opaque bg-background (gradient-image trick):
        // the card floats in the composer overlay, so a translucent bg
        // would let transcript entries underneath show through it. `bare`
        // hosts (the prompt-blob widget) already wrap this in their own
        // equivalently-tinted card, so they skip it.
        !bare &&
          "rounded-lg border border-border bg-background bg-gradient-to-b from-muted/40 to-muted/40 p-3",
      )}
    >
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
