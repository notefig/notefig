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
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
  /**
   * Shown when the adapter reports authentication is required, e.g.
   * "Run `claude login` in a terminal on this machine."
   */
  authHint: z.string().optional(),
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
    authHint: "Run `claude login` in a terminal on this machine.",
  },
  {
    id: "gemini-cli",
    label: "Gemini CLI",
    command: "gemini",
    args: ["--experimental-acp"],
    env: {},
    authHint: "Run `gemini` once in a terminal to sign in.",
  },
];
