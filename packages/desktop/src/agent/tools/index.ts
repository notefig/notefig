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
 * machinery. The MCP server (`mcp-server.ts`, Stage 3.5) is its consumer —
 * `tools/list` renders each tool's Zod schema as JSON Schema and
 * `tools/call` dispatches through `dispatchToolCall`. (The Stage 2
 * prompt-guided fence channel that used to read this list was deleted with
 * Stage 3.5/4 — every supported harness now reaches tools over MCP.)
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
