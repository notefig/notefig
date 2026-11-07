/**
 * File-level "an agent is currently touching this file" presence, derived
 * from the same transcript rows the panel already renders — no separate
 * activity tracker. Which calls count and what they touch is read by
 * `modules/agents/tool-call-locations.ts`, which sync's presence shares to
 * publish the same activity to collaborators (MET-272).
 */
import { useLiveQuery, eq } from "@tanstack/react-db";
import { useCore } from "@notefig/core/react";
import { isActiveToolCall } from "@/modules/agents/tool-call-locations";

export function useAgentEditingPaths(): Set<string> {
  const { entries } = useCore().agentStore;
  const { data: activeToolCalls = [] } = useLiveQuery((q) =>
    q
      .from({ entry: entries })
      .where(({ entry }) => eq(entry.type, "tool_call")),
  );

  const paths = new Set<string>();
  for (const entry of activeToolCalls) {
    if (!entry.toolCall || !isActiveToolCall(entry.toolCall)) continue;
    for (const location of entry.toolCall.locations ?? []) {
      paths.add(location.path);
    }
  }
  return paths;
}
