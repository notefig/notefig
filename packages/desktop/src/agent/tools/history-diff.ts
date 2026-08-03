import { z } from "zod";
import type { AgentTool } from "@metrists/shared/agent";
import {
  ensureWorkspaceHistoryInitialized,
  historyGitDir,
  resolveHistoryDocumentPath,
} from "@/utils/history-service";

const InputSchema = z.object({
  path: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
});

export interface HistoryDiffResult {
  from: string;
  to: string;
  fromContent: string;
  toContent: string;
}

export const historyDiff: AgentTool<
  z.infer<typeof InputSchema>,
  HistoryDiffResult
> = {
  name: "history_diff",
  title: "agentToolHistoryDiff",
  description:
    "Read a document's content at two checkpoints so the agent can compare them.",
  input: InputSchema,
  async execute(ctx, input) {
    const resolved = resolveHistoryDocumentPath(ctx.workspacePath, input.path);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    try {
      const service = await ensureWorkspaceHistoryInitialized(
        ctx.workspacePath,
      );
      const gitDir = historyGitDir(ctx.workspacePath);
      const [fromContent, toContent] = await Promise.all([
        service.readTextFile({
          repoPath: ctx.workspacePath,
          gitDir,
          ref: input.from,
          filepath: resolved.relative,
        }),
        service.readTextFile({
          repoPath: ctx.workspacePath,
          gitDir,
          ref: input.to,
          filepath: resolved.relative,
        }),
      ]);
      return {
        ok: true,
        value: { from: input.from, to: input.to, fromContent, toContent },
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
};
