import { useState } from "react";
import { Loader2 } from "lucide-react";
import { z } from "zod";
import { defineBlobType } from "./blob-type";
import { useBlobAnswer } from "./use-blob-answer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * The agent asks the user a contextual question inside the document.
 *
 * ```notefig:question
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
    // Which control is mid-submit, so the spinner lands on the one the user
    // actually clicked (options) rather than every button at once.
    const [submitting, setSubmitting] = useState<string | null>(null);
    const pending = state === "pending";

    const submit = (value: string) => {
      setSubmitting(value);
      void run({ answer: value });
    };

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
                disabled={pending}
                onClick={() => submit(option)}
              >
                {pending && submitting === option && (
                  <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                )}
                {option}
              </Button>
            ))}
          </div>
        ) : (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (freeText.trim()) submit(freeText.trim());
            }}
          >
            <Input
              value={freeText}
              onChange={(e) => setFreeText(e.target.value)}
              disabled={pending}
              placeholder="Type an answer…"
              className="h-8"
            />
            <Button type="submit" size="sm" disabled={pending || !freeText.trim()}>
              {pending ? (
                <>
                  <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                  Sending…
                </>
              ) : (
                "Send"
              )}
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
  formatAnswerPrompt: ({ blobId, path, envelope, patch }) => {
    const answer =
      typeof patch.answer === "string" ? patch.answer : JSON.stringify(patch);
    const question =
      typeof envelope.prompt === "string" ? ` ("${envelope.prompt}")` : "";
    return (
      `The user answered your question block ${blobId}${question} in ${path}: ${answer}\n\n` +
      `Now replace that answered block in ${path} with the content the answer resolves to, ` +
      `using your normal editing tools: fold the answer into the document and remove the ` +
      `\`\`\`notefig:question fence with id ${blobId} — it has served its purpose. ` +
      `Do not re-ask the question.`
    );
  },
});
