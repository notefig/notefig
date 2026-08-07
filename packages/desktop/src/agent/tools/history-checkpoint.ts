import { z } from "zod";
import type { AgentTool } from "@notefig/shared/agent";
import { checkpointWorkspaceHistory } from "@/utils/history-service";

const InputSchema = z.object({
  message: z.string().min(1),
});

export const historyCheckpoint: AgentTool<
  z.infer<typeof InputSchema>,
  { oid: string | null }
> = {
  name: "history_checkpoint",
  title: "agentToolHistoryCheckpoint",
  description: "Commit an explicit, named document-history checkpoint now.",
  input: InputSchema,
  async execute(ctx, input) {
    try {
      const oid = await checkpointWorkspaceHistory(ctx.workspacePath, input.message, {
        name: "agent",
        email: "agent@notefig.local",
      });
      return { ok: true, value: { oid } };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
};
