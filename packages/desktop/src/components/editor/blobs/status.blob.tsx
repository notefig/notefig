import { z } from "zod";
import { Check, Circle, Loader2, X } from "lucide-react";
import { defineBlobType } from "./blob-type";

const STATE_ICON = {
  queued: <Circle className="size-3.5 shrink-0 text-muted-foreground" />,
  working: <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />,
  done: <Check className="size-3.5 shrink-0 text-green-600 dark:text-green-400" />,
  failed: <X className="size-3.5 shrink-0 text-destructive" />,
} as const;

/**
 * Agent-updated progress card. Read-only for the user: the agent patches it
 * as work proceeds, so there is no answer path.
 */
export default defineBlobType({
  type: "status",
  schema: z.object({
    title: z.string(),
    state: z.enum(["queued", "working", "done", "failed"]).default("queued"),
    detail: z.string().optional(),
  }),
  Widget({ payload }) {
    return (
      <div className="flex items-center gap-2 text-sm">
        {STATE_ICON[payload.state]}
        <div>
          <div className="font-medium">{payload.title}</div>
          {payload.detail && (
            <div className="text-xs text-muted-foreground">{payload.detail}</div>
          )}
        </div>
      </div>
    );
  },
  // Read-only: nothing to fold in beyond the patch itself.
  onAnswer: (_blob, patch) => patch,
  summaryText: (payload) => `${payload.title} [${payload.state}]`,
});
