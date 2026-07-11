import { z } from "zod";
import { defineBlobType } from "./blob-type";
import { useBlobAnswer } from "./use-blob-answer";
import { Button } from "@/components/ui/button";

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
  Widget({ blob, payload, answer }) {
    const { state, run } = useBlobAnswer(answer);

    if (blob.envelope.status === "answered") {
      return (
        <div className="text-sm">
          <span className="font-medium">{payload.prompt}</span>
          {payload.decision && (
            <span className="text-muted-foreground"> — {payload.decision}</span>
          )}
        </div>
      );
    }

    return (
      <div className="text-sm">
        <div className="mb-2 font-medium">{payload.prompt}</div>
        {payload.details && (
          <details className="mb-2 text-xs text-muted-foreground">
            <summary className="cursor-pointer">Details</summary>
            <p className="mt-1 whitespace-pre-wrap">{payload.details}</p>
          </details>
        )}
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={state === "pending"}
            onClick={() => void run({ decision: "approved" })}
          >
            Approve
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={state === "pending"}
            onClick={() => void run({ decision: "rejected" })}
          >
            Reject
          </Button>
        </div>
        {state === "not_found" && (
          <div className="mt-2 text-xs text-muted-foreground">
            This approval was changed or removed — reload the document.
          </div>
        )}
        {state === "conflict" && (
          <div className="mt-2 text-xs text-muted-foreground">
            Someone else answered this — refresh to see the current state.
          </div>
        )}
      </div>
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
