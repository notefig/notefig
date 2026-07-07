import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type {
  PendingPermission,
  PermissionBroker,
} from "@/agent/permission-broker";
import type { PermissionOption } from "@metrists/shared/agent";

/** Subscribe to a task's pending permission queue (in-memory, not a collection). */
export function usePendingPermissions(
  broker: PermissionBroker | undefined,
): PendingPermission[] {
  const [pending, setPending] = useState<PendingPermission[]>([]);
  useEffect(() => {
    if (!broker) {
      setPending([]);
      return;
    }
    return broker.subscribe(setPending);
  }, [broker]);
  return pending;
}

/** ACP option kind → button emphasis. Options render verbatim otherwise. */
function variantForKind(
  kind: PermissionOption["kind"],
): "default" | "outline" {
  return kind === "allow_once" || kind === "allow_always"
    ? "default"
    : "outline";
}

/**
 * Renders the head of the active task's permission queue: the tool-call title
 * and the agent-provided options, verbatim. Resolving one settles the promise
 * the ACP client is awaiting; cancellation (session/cancel) clears the queue.
 */
export function PermissionCard({ broker }: { broker: PermissionBroker }) {
  const pending = usePendingPermissions(broker);
  const head = pending[0];
  if (!head) return null;

  const { request } = head;
  const title = request.toolCall.title ?? "The agent is requesting permission";

  return (
    <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm">
      <div className="mb-2 font-medium">{title}</div>
      <div className="flex flex-wrap gap-2">
        {request.options.map((option) => (
          <Button
            key={option.optionId}
            size="sm"
            variant={variantForKind(option.kind)}
            onClick={() =>
              broker.respond(head.id, {
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
