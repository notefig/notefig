import { NO_PREP, type HarnessAdapter } from "./adapter";

/**
 * Claude Code, through the bundled claude-agent-acp sidecar.
 *
 * "session-new": the adapter takes the server over the wire, in
 * `session/new.mcpServers` (claude-agent-acp — verified in
 * v2-mcp-passthrough-spike.md). Nothing to write, nothing to inject; the
 * only mode that can carry a non-stdio server.
 */
export const claudeCodeAdapter: HarnessAdapter = {
  onInvoke: async ({ mcpServer }) => ({
    ...NO_PREP,
    passThroughSessionNew: mcpServer !== undefined,
  }),
  // Cost on `usage_update`; rate-limit windows in its `_meta`.
  reporting: { cost: true, limits: true },
};
