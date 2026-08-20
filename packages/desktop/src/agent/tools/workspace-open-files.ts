import { z } from "zod";
import type { AgentTool } from "@notefig/agent";
import {
  getWorkspaceEditorContext,
  type WorkspaceEditorContext,
} from "@/entities/editors";

const InputSchema = z.object({});

export const workspaceOpenFiles: AgentTool<
  z.infer<typeof InputSchema>,
  WorkspaceEditorContext
> = {
  name: "workspace_open_files",
  title: "agentToolWorkspaceOpenFiles",
  description:
    "What the user currently has open: tabs, the active file, and whether there's a selection.",
  input: InputSchema,
  async execute(ctx) {
    return { ok: true, value: getWorkspaceEditorContext(ctx.workspacePath) };
  },
};
