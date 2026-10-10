import { NO_PREP, type HarnessAdapter } from "./adapter";

/** Gemini CLI. No capability-matrix row yet, so "none": it gets no app
 *  tools. */
export const geminiCliAdapter: HarnessAdapter = {
  onInvoke: async () => NO_PREP,
};
