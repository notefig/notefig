import { z } from "zod";
import type { AgentTool } from "@metrists/shared/agent";
import {
  ensureWorkspaceHistoryInitialized,
  historyGitDir,
} from "@/utils/history-service";

const InputSchema = z.object({
  path: z.string().min(1).optional(),
});

export interface HistoryLogEntry {
  oid: string;
  message: string;
  author: string;
  timestamp: number;
}

export const historyLog: AgentTool<
  z.infer<typeof InputSchema>,
  HistoryLogEntry[]
> = {
  name: "history_log",
  title: "agentToolHistoryLog",
  description:
    "List document-history checkpoints (most recent first), optionally scoped to one file's path.",
  input: InputSchema,
  async execute(ctx, input) {
    try {
      const service = await ensureWorkspaceHistoryInitialized(ctx.workspacePath);
      const commits = await service.log({
        repoPath: ctx.workspacePath,
        gitDir: historyGitDir(ctx.workspacePath),
        filepath: input.path,
      });
      const value = commits.map((c) => ({
        oid: c.oid,
        message: c.commit.message.trim(),
        author: c.commit.author.name,
        timestamp: c.commit.author.timestamp * 1000,
      }));
      return { ok: true, value };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
};
