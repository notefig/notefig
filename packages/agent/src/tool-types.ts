import type { z } from "zod";

/**
 * A Metrists-native agent tool. One plain object per tool, one file each —
 * see `packages/desktop/src/agent/tools/index.ts` for the registry. Delivered
 * to harnesses over MCP (`packages/desktop/src/agent/mcp-server.ts`, Stage
 * 3.5) — the interface stayed channel-agnostic since Stage 2 specifically so
 * that migration was a second consumer of the same registry, not a redesign.
 */
export interface AgentTool<In, Out> {
  /** Invocation identifier — stable, not shown to the user. */
  name: string;
  /**
   * i18next translation key (not literal text) for the human-readable
   * display name (MCP's `Tool.title`) — what the user sees in permission
   * prompts and tool-call UI, distinct from `name`. Resolved at the point of
   * use (e.g. `mcp-server.ts`'s `tools/list`), never baked into this object
   * at module-load time, so it reflects the active language even if it
   * changes later. This package can't import `desktop`'s i18n instance, so this
   * stays a plain string key here — desktop owns resolving it (injected as
   * `McpHandlerDeps.translate`).
   */
  title: string;
  description: string;
  input: z.ZodType<In>;
  /**
   * Optional hand-rendered JSON Schema for `tools/list`, regenerated per
   * call; when absent, the generic zodToJsonSchema rendering of `input` is
   * used. `author_blob` sets this: its payload shape depends on the
   * registered blob types, which only the tool's own module can enumerate —
   * the protocol layer stays tool-agnostic.
   */
  inputJsonSchema?: () => unknown;
  /** Mutating tools set this so the MCP dispatch gates behind the existing
   *  PermissionBroker before calling `execute` — no second consent surface. */
  requiresPermission?: boolean;
  execute(ctx: ToolContext, input: In): Promise<ToolResult<Out>>;
}

/**
 * `agents` is desktop's Stage 1 entity-handle facade
 * (`packages/desktop/src/agent/agents.ts`). It's typed structurally here
 * (this package can't import from desktop) — just enough surface for tools to act
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
