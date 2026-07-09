import type { z } from "zod";

/**
 * A Metrists-native agent tool. One plain object per tool, one file each —
 * see `packages/desktop/src/agent/tools/index.ts` for the registry. V2
 * delivers tools via prompt-guided fences (no MCP); the interface itself is
 * channel-agnostic so an MCP server can consume the same registry later.
 */
export interface AgentTool<In, Out> {
  name: string;
  description: string;
  input: z.ZodType<In>;
  /** Mutating tools set this so the fence-execution wiring gates behind the
   *  existing PermissionBroker before calling `execute` — no second consent
   *  surface. */
  requiresPermission?: boolean;
  execute(ctx: ToolContext, input: In): Promise<ToolResult<Out>>;
}

/**
 * `agents` is desktop's Stage 1 entity-handle facade
 * (`packages/desktop/src/agent/agents.ts`). It's typed structurally here
 * (shared can't import from desktop) — just enough surface for tools to act
 * through it rather than reaching into service internals.
 */
export interface ToolAgentsFacade {
  task(taskId: string): {
    prompt(text: string): unknown;
    cancel(): Promise<unknown>;
  };
  workspace(workspacePath: string): {
    createTask(harness: unknown): Promise<unknown>;
  };
}

export interface ToolContext {
  workspacePath: string;
  taskId: string;
  agents: ToolAgentsFacade;
}

export type ToolResult<Out> =
  | { ok: true; value: Out }
  | { ok: false; error: string };
