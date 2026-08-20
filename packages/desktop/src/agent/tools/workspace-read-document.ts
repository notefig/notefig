import { z } from "zod";
import type { AgentTool } from "@notefig/agent";
import { readWorkspaceTextFile } from "@/utils/file-sync";
import { resolveWorkspacePath } from "@/utils/fs";

const InputSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().positive().optional(),
  limit: z.number().int().positive().optional(),
});

export const workspaceReadDocument: AgentTool<
  z.infer<typeof InputSchema>,
  string
> = {
  name: "workspace_read_document",
  title: "agentToolWorkspaceReadDocument",
  description:
    "Read a workspace document's content by path. Optional 1-based `line` + `limit` for a partial read. " +
    "If this turn's prompt carries a widget-context resource_link, read that first via " +
    "resources/read — only reach for this tool (or a full, unbounded read) when that resource's " +
    "outline and surrounding text don't cover what you need.",
  input: InputSchema,
  async execute(ctx, input) {
    const resolved = resolveWorkspacePath(ctx.workspacePath, input.path);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    try {
      const value = await readWorkspaceTextFile(resolved.absolute, {
        line: input.line,
        limit: input.limit,
      });
      return { ok: true, value };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
};
