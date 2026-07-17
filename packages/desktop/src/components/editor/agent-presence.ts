/**
 * File-level "an agent is currently touching this file" presence, derived
 * from the same transcript rows the panel already renders — no separate
 * activity tracker. Native ACP tool calls carry `locations` from the
 * adapter; MCP app tools don't (confirmed absent on every MCP tool_call in
 * the Stage 3.5 pass-through spike), so `upsertToolEntry` in
 * agent-service.ts derives them from `rawInput.path` instead.
 */
import { useLiveQuery, eq } from "@tanstack/react-db";
import { agentEntriesCollection } from "@/agent/agent-collections";

const ACTIVE_STATUSES = new Set(["pending", "in_progress"]);

export function useAgentEditingPaths(): Set<string> {
  const { data: activeToolCalls = [] } = useLiveQuery((q) =>
    q.from({ entry: agentEntriesCollection }).where(({ entry }) => eq(entry.type, "tool_call")),
  );

  const paths = new Set<string>();
  for (const entry of activeToolCalls) {
    const status = entry.toolCall?.status;
    if (!status || !ACTIVE_STATUSES.has(status)) continue;
    for (const location of entry.toolCall?.locations ?? []) {
      paths.add(location.path);
    }
  }
  return paths;
}
