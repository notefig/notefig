import { z } from "zod";
import { resolveWorkspacePath } from "@/utils/fs";
import type { AgentTool } from "@notefig/shared/agent";
import {
  ensureWorkspaceHistoryInitialized,
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
    // `path` is an optional scope filter; git wants it workspace-relative.
    let filepath: string | undefined;
    if (input.path) {
      const resolved = resolveWorkspacePath(ctx.workspacePath, input.path);
      if (!resolved.ok) return { ok: false, error: resolved.error };
      filepath = resolved.relative;
    }
    try {
      const service = await ensureWorkspaceHistoryInitialized(ctx.workspacePath);
      const commits = await service.log({
        filepath,
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
