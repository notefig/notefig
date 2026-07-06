import { z } from "zod";
import { defineBlobType } from "./blob-registry";

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
    // TODO(phase 2): progress chrome per state.
    return (
      <div>
        {payload.title}: {payload.state}
      </div>
    );
  },
  // Read-only: nothing to fold in beyond the patch itself.
  onAnswer: (_blob, patch) => patch,
  summaryText: (payload) => `${payload.title} [${payload.state}]`,
});
