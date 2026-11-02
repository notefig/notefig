import { z } from "zod";
import type { AgentTool } from "@notefig/agent";
import { PROCESS_MAX_LINES } from "@notefig/widgets";
import { workspaceKey } from "@/utils/path";

const InputSchema = z.object({
  blobId: z.string().min(1),
  lines: z.number().int().min(1).max(PROCESS_MAX_LINES).optional(),
});

/**
 * The agent's view of a block it started with `process_start` (MET-258):
 * whether it still runs, and its last lines of stdout — what the block
 * shows the user, read from the same buffer (`core.processBlocks`).
 * Read-only, so not permission-gated; scoped to the asking agent's
 * workspace, so a marker carried into another workspace reads nothing.
 */
export const processOutput: AgentTool<
  z.infer<typeof InputSchema>,
  { running: boolean; lines: string[] }
> = {
  name: "process_output",
  title: "agentToolProcessOutput",
  description:
    "Read a block started with `process_start`: whether its command is " +
    "still running, and its last `lines` lines of stdout (default 50).",
  input: InputSchema,
  async execute(ctx, input) {
    const { blobId, lines = 50 } = input;
    const blocks = ctx.services.processBlocks;
    await blocks.loaded();
    const block = blocks.get(blobId);
    const cwd = blocks.cwdOf(blobId);
    if (
      !block.command ||
      cwd === undefined ||
      workspaceKey(cwd) !== workspaceKey(ctx.workspacePath)
    ) {
      return { ok: false, error: `No process block ${blobId}` };
    }
    return {
      ok: true,
      value: { running: block.running, lines: block.lines.slice(-lines) },
    };
  },
};
