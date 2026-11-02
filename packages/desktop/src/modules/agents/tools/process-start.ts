import { z } from "zod";
import type { AgentTool } from "@notefig/agent";
import { serializeProcessMarker } from "@notefig/widgets";

const InputSchema = z.object({
  command: z.string().min(1),
});

/**
 * Run a shell command in the workspace and show its output in the document
 * (MET-258), as `widget_respond` delivers a response to the widget: the
 * agent asks, the app does it. The app mints the block's id and registers
 * the command under it (`core.processBlocks`), so the marker the agent
 * writes into the document carries nothing but that id, and a block no
 * agent started through here never renders.
 *
 * Permission-gated: it runs a command outside the harness's own shell, and
 * past whatever gate the harness puts on that. The approval card names the
 * command and the folder it runs in (`describeCall`).
 */
export const processStart: AgentTool<
  z.infer<typeof InputSchema>,
  { blobId: string; marker: string }
> = {
  name: "process_start",
  title: "agentToolProcessStart",
  description:
    "Start a shell command in the workspace root and show its live stdout " +
    "in the document, for a long-running command (a dev server, a build, a " +
    "watcher) whose output the user should see. Returns `marker`: write it " +
    "into the document, on a line of its own, where the output belongs. " +
    "The user can run the command again from there once it ends. Read its " +
    "output with `process_output`.",
  input: InputSchema,
  requiresPermission: true,
  describeCall: (input, ctx) => `${input.command} (in ${ctx.workspacePath})`,
  async execute(ctx, input) {
    const blobId = await ctx.services.processBlocks.start({
      command: input.command,
      cwd: ctx.workspacePath,
      taskId: ctx.taskId,
    });
    return {
      ok: true,
      value: { blobId, marker: serializeProcessMarker({ blobId })! },
    };
  },
};
