import { z } from "zod";

/**
 * A harness definition describes how to spawn an ACP agent adapter on the
 * user's machine. Definitions come from Metrists built-ins or user settings —
 * never from document content (spawning is gated by per-workspace trust).
 */
export const HarnessDefinitionSchema = z.object({
  /** Stable identifier, e.g. "claude-code" */
  id: z.string().min(1),
  /** Human-readable name shown in settings and the agent panel */
  label: z.string().min(1),
  /** Executable to spawn (resolved against PATH) */
  command: z.string().min(1),
  /** `${workspace}` in an arg is replaced with the workspace path at spawn. */
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
  /**
   * Shown when the adapter reports authentication is required, e.g.
   * "Run `claude login` in a terminal on this machine."
   */
  authHint: z.string().optional(),
  /**
   * How this harness learns about the app's MCP tool server — set from the
   * capability matrix (docs/architecture/acp-capability-matrix.md), NOT from
   * the adapter's self-reported `mcpCapabilities` (unreliable: OpenCode
   * advertises http/sse but ignores `session/new.mcpServers`).
   * - "session-new": pass the server through ACP `session/new.mcpServers`
   *   (claude-agent-acp — verified in v2-mcp-passthrough-spike.md).
   * - "opencode-config": write a per-task config file registering the server
   *   and point the spawned process at it via `OPENCODE_CONFIG` (verified in
   *   v2-opencode-config-mcp-spike.md).
   * - "none": harness gets no app tools.
   */
  mcpRegistration: z.enum(["session-new", "opencode-config", "none"]),
});

export type HarnessDefinition = z.infer<typeof HarnessDefinitionSchema>;

/**
 * Harnesses Metrists knows how to spawn out of the box. Each is an existing
 * ACP adapter; a future Metrists-owned harness is just another entry.
 */
export const BUILT_IN_HARNESSES: HarnessDefinition[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    command: "npx",
    args: ["-y", "@agentclientprotocol/claude-agent-acp"],
    env: {},
    authHint: "Run `claude /login` in a terminal on this machine.",
    mcpRegistration: "session-new",
  },
  {
    id: "opencode",
    label: "OpenCode",
    // --cwd scopes OpenCode's project detection to the workspace (the spike
    // relied on it); session/new's cwd alone is not guaranteed to set it.
    command: "opencode",
    args: ["acp", "--cwd", "${workspace}"],
    env: {},
    authHint: "Run `opencode auth login` in a terminal on this machine.",
    mcpRegistration: "opencode-config",
  },
  {
    id: "gemini-cli",
    label: "Gemini CLI",
    command: "gemini",
    args: ["--experimental-acp"],
    env: {},
    authHint: "Run `gemini` once in a terminal to sign in.",
    // No capability-matrix row for gemini yet — don't assume pass-through.
    mcpRegistration: "none",
  },
];
