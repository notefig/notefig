import { useState } from "react";
import { z } from "zod";
import { defineBlobType } from "./blob-type";
import { useBlobAnswer } from "./use-blob-answer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * The agent asks the user a contextual question inside the document.
 *
 * ```metrists:question
 * id: q_8f2a
 * status: pending
 * prompt: Which pricing tier does this doc target?
 * options: [Free, Pro, Enterprise]
 * ```
 */
export default defineBlobType({
  type: "question",
  schema: z.object({
    prompt: z.string(),
    /** When present, render as choices; otherwise free-text input */
    options: z.array(z.string()).optional(),
    answer: z.string().optional(),
  }),
  Widget({ blob, payload, answer }) {
    const { state, run } = useBlobAnswer(answer);
    const [freeText, setFreeText] = useState("");

    // Render state, derived from the fence's own status on every render —
    // not a local "I clicked answer" flag — so a reload or an agent-side
    // rewrite of the fence is always reflected correctly.
    if (blob.envelope.status === "answered") {
      return (
        <div className="text-sm">
          <span className="font-medium">{payload.prompt}</span>
          {payload.answer && (
            <span className="text-muted-foreground"> — {payload.answer}</span>
          )}
        </div>
      );
    }

    return (
      <div className="text-sm">
        <div className="mb-2 font-medium">{payload.prompt}</div>
        {payload.options ? (
          <div className="flex flex-wrap gap-2">
            {payload.options.map((option) => (
              <Button
                key={option}
                size="sm"
                variant="outline"
                disabled={state === "pending"}
                onClick={() => void run({ answer: option })}
              >
                {option}
              </Button>
            ))}
          </div>
        ) : (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (freeText.trim()) void run({ answer: freeText.trim() });
            }}
          >
            <Input
              value={freeText}
              onChange={(e) => setFreeText(e.target.value)}
              disabled={state === "pending"}
              placeholder="Type an answer…"
              className="h-8"
            />
            <Button
              type="submit"
              size="sm"
              disabled={state === "pending" || !freeText.trim()}
            >
              Send
            </Button>
          </form>
        )}
        {state === "not_found" && (
          <div className="mt-2 text-xs text-muted-foreground">
            This question was changed or removed — reload the document.
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
    payload.answer
      ? `${payload.prompt} — ${payload.answer}`
      : payload.prompt,
});
