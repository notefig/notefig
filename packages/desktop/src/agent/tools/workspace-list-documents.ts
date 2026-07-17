import { z } from "zod";
import type { AgentTool } from "@metrists/shared/agent";
import { getOrCreateWorkspaceCollections } from "@/utils/collections";
import { getFileName } from "@/utils/fs";

const InputSchema = z.object({});

export interface WorkspaceDocument {
  path: string;
  type: "file" | "directory";
  /** Filename for now — no frontmatter-title pipeline exists yet. */
  title: string;
}

export const workspaceListDocuments: AgentTool<
  z.infer<typeof InputSchema>,
  WorkspaceDocument[]
> = {
  name: "workspace_list_documents",
  title: "agentToolWorkspaceListDocuments",
  description:
    "List every document in the workspace (path, type, title). Title is the filename for now.",
  input: InputSchema,
  async execute(ctx) {
    const { metadata } = getOrCreateWorkspaceCollections(ctx.workspacePath);
    const value = metadata.toArray.map((entry) => ({
      path: entry.path,
      type: entry.type,
      title: getFileName(entry.path),
    }));
    return { ok: true, value };
  },
};
