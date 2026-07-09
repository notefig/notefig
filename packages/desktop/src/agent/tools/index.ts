import type { AgentTool } from "@metrists/shared/agent";
import { workspaceListDocuments } from "./workspace-list-documents";
import { workspaceReadDocument } from "./workspace-read-document";
import { workspaceOpenFiles } from "./workspace-open-files";
import { historyLog } from "./history-log";
import { historyDiff } from "./history-diff";
import { historyCheckpoint } from "./history-checkpoint";
import { historyRestore } from "./history-restore";
import { authorBlob } from "./author-blob";

/**
 * The tool registry: one direct-imported array, no dynamic registration
 * machinery. Prompt-guided delivery (Stage 2, `tool-fence.ts`) renders this
 * list into the guidance preamble and validates fence invocations against
 * it; a future MCP channel would be a second consumer of the same array.
 */
export const toolRegistry: readonly AgentTool<unknown, unknown>[] = [
  workspaceListDocuments,
  workspaceReadDocument,
  workspaceOpenFiles,
  historyLog,
  historyDiff,
  historyCheckpoint,
  historyRestore,
  authorBlob,
] as unknown as readonly AgentTool<unknown, unknown>[];

export function getTool(name: string): AgentTool<unknown, unknown> | undefined {
  return toolRegistry.find((tool) => tool.name === name);
}
