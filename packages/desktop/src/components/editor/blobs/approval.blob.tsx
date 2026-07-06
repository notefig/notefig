import { z } from "zod";
import { defineBlobType } from "./blob-registry";

/**
 * The agent asks the user to approve or reject a described action before
 * proceeding (distinct from ACP session/request_permission, which is
 * tool-level and ephemeral — an approval blob is part of the document).
 */
export default defineBlobType({
  type: "approval",
  schema: z.object({
    prompt: z.string(),
    details: z.string().optional(),
    decision: z.enum(["approved", "rejected"]).optional(),
  }),
  Widget({ payload, answer }) {
    // TODO(phase 2): approve/reject buttons with details disclosure.
    return (
      <button onClick={() => void answer({ decision: "approved" })}>
        {payload.prompt}
      </button>
    );
  },
  onAnswer: (_blob, patch) => ({
    ...patch,
    status: "answered",
    answeredAt: new Date().toISOString(),
  }),
  summaryText: (payload) =>
    payload.decision ? `${payload.prompt} — ${payload.decision}` : payload.prompt,
});
