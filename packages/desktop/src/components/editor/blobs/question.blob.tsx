import { z } from "zod";
import { defineBlobType } from "./blob-type";

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
  Widget({ payload, answer }) {
    // TODO(phase 2): real UI (options as buttons, free text otherwise).
    return (
      <button onClick={() => void answer({ answer: payload.options?.[0] })}>
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
    payload.answer
      ? `${payload.prompt} — ${payload.answer}`
      : payload.prompt,
});
