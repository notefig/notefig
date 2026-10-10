import {
  ACP_USAGE,
  KNOWN_TOOL_PREFIXES,
  NO_PREP,
  NO_REPORTING,
  type HarnessAdapter,
} from "./adapter";

/** Gemini CLI. No capability-matrix row yet, so "none": it gets no app
 *  tools. */
export const geminiCliAdapter: HarnessAdapter = {
  onInvoke: async () => NO_PREP,
  reporting: NO_REPORTING,
  // Unrecorded which prefix it mints; strip either.
  toolNamePrefixes: KNOWN_TOOL_PREFIXES,
  usage: ACP_USAGE,
  logo: {
    viewBox: "0 0 24 24",
    paths: [
      { d: "M12 24A14.304 14.304 0 0 0 0 12 14.304 14.304 0 0 0 12 0a14.305 14.305 0 0 0 12 12 14.305 14.305 0 0 0-12 12Z" },
    ],
  },
};
