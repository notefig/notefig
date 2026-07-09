import { z } from "zod";
import type { AgentTool } from "@metrists/shared/agent";
import {
  getWorkspaceEditorContext,
  type WorkspaceEditorContext,
} from "@/components/editor/editor-store";

const InputSchema = z.object({});

export const workspaceOpenFiles: AgentTool<
  z.infer<typeof InputSchema>,
  WorkspaceEditorContext
> = {
  name: "workspace_open_files",
  description:
    "What the user currently has open: tabs, the active file, and whether there's a selection.",
  input: InputSchema,
  async execute(ctx) {
    return { ok: true, value: getWorkspaceEditorContext(ctx.workspacePath) };
  },
};
