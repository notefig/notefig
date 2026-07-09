import { z } from "zod";
import type { AgentTool } from "@metrists/shared/agent";
import { readWorkspaceTextFile } from "@/utils/file-sync";

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
  description:
    "Read a workspace document's content by path. Optional 1-based `line` + `limit` for a partial read.",
  input: InputSchema,
  async execute(_ctx, input) {
    try {
      const value = await readWorkspaceTextFile(input.path, {
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
