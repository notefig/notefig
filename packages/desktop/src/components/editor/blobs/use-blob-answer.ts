import { useState } from "react";
import type { BlobWidgetProps } from "./blob-type";
import { BlobAnswerError } from "./blob-actions";

export type BlobAnswerState = "idle" | "pending" | "conflict" | "not_found";

/**
 * Shared submit-state handling for interactive blob widgets: tracks the
 * in-flight/conflict/not_found states an `answer()` call can end in, so
 * question/approval widgets don't each reimplement the same try/catch.
 */
export function useBlobAnswer(answer: BlobWidgetProps<unknown>["answer"]) {
  const [state, setState] = useState<BlobAnswerState>("idle");

  const run = async (patch: Record<string, unknown>): Promise<void> => {
    setState("pending");
    try {
      await answer(patch);
      setState("idle");
    } catch (error) {
      setState(error instanceof BlobAnswerError ? error.reason : "idle");
    }
  };

  return { state, run };
}
