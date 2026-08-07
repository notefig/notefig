import { useState } from "react";
import { Loader2 } from "lucide-react";
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
    // Track the clicked decision so the spinner shows on that button only.
    const [submitting, setSubmitting] = useState<"approved" | "rejected" | null>(
      null,
    );
    const pending = state === "pending";

    const decide = (decision: "approved" | "rejected") => {
      setSubmitting(decision);
      void run({ decision });
    };

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
          <Button size="sm" disabled={pending} onClick={() => decide("approved")}>
            {pending && submitting === "approved" && (
              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
            )}
            Approve
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => decide("rejected")}
          >
            {pending && submitting === "rejected" && (
              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
            )}
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
  formatAnswerPrompt: ({ blobId, path, envelope, patch }) => {
    const decision =
      typeof patch.decision === "string" ? patch.decision : JSON.stringify(patch);
    const subject =
      typeof envelope.prompt === "string" ? ` ("${envelope.prompt}")` : "";
    const followThrough =
      decision === "approved"
        ? `Proceed with the approved action, then replace that answered block in ${path} ` +
          `with the content it resolves to, using your normal editing tools — remove the ` +
          `\`\`\`notefig:approval fence with id ${blobId} once the outcome is folded into ` +
          `the document.`
        : `Do not proceed with the action. Replace that answered block in ${path} with ` +
          `whatever the rejection resolves to (usually removing the ` +
          `\`\`\`notefig:approval fence with id ${blobId} and leaving the document as-is, ` +
          `or noting the decision), using your normal editing tools.`;
    return (
      `The user ${decision} your approval block ${blobId}${subject} in ${path}.\n\n` +
      followThrough
    );
  },
});
