import { z } from "zod";
import type { AgentTool } from "@metrists/shared/agent";
import { writeWorkspaceTextFile } from "@/utils/file-sync";
import { resolveWorkspacePath } from "@/utils/fs";
import {
  ensureWorkspaceHistoryInitialized,
  historyGitDir,
} from "@/utils/history-service";

const InputSchema = z.object({
  path: z.string().min(1),
  checkpoint: z.string().min(1),
});

export const historyRestore: AgentTool<z.infer<typeof InputSchema>, void> = {
  name: "history_restore",
  title: "agentToolHistoryRestore",
  description:
    "Restore a document's content to an earlier checkpoint. Writes through the normal editor pipeline, so an open editor picks it up like any other write.",
  input: InputSchema,
  requiresPermission: true,
  async execute(ctx, input) {
    // Git wants the workspace-relative path; the editor write wants the
    // absolute one. Resolve once, use both halves.
    const resolved = resolveWorkspacePath(ctx.workspacePath, input.path);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    try {
      const service = await ensureWorkspaceHistoryInitialized(ctx.workspacePath);
      const content = await service.readTextFile({
        repoPath: ctx.workspacePath,
        gitDir: historyGitDir(ctx.workspacePath),
        ref: input.checkpoint,
        filepath: resolved.relative,
      });
      await writeWorkspaceTextFile(resolved.absolute, content);
      return { ok: true, value: undefined };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
};
