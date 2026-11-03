import { cn } from "@notefig/ui/utils";
import { choiceChipClass } from "@notefig/widgets/prompt/ui/widget-response-view";
import { usePendingPermissions } from "@/modules/agents/react";
import type { PermissionOption } from "@notefig/shared/agent";
import { useCore } from "@notefig/core/react";

/**
 * Renders the head of a task's pending permission queue: the tool-call title
 * and the agent-provided options, verbatim, as the prompt widget's choice
 * chips: a permission is the agent asking a question too. Reads the queue from
 * agentPermissionRequestsCollection (the one bus); answering settles the
 * promise the ACP client is awaiting via the task's respondPermission.
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
  const { agents } = useCore();
  const pending = usePendingPermissions(taskId);
  // Ids sort chronological; the hook returns oldest-first.
  const head = pending[0];
  if (!head) return null;

  const options = head.options as PermissionOption[];

  return (
    <div
      data-permission-card
      data-permission-id={head.id}
      data-permission-pending={pending.length}
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
      <div className="mb-1.5 font-medium">{head.title}</div>
      <div className="flex flex-wrap items-center gap-1.5">
        {options.map((option) => (
          <button
            key={option.optionId}
            type="button"
            className={choiceChipClass}
            onClick={() =>
              agents.task(taskId).respondPermission(head.id, {
                outcome: { outcome: "selected", optionId: option.optionId },
              })
            }
          >
            {option.name}
          </button>
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
