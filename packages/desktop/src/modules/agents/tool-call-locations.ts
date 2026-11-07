/**
 * Where a tool call is acting, read off the call itself: the one reading
 * shared by the editor's "an agent is touching this file" marker
 * (`components/editor/agent-presence.ts`) and sync's presence, which
 * publishes the same activity to collaborators (MET-272). Pure: callers
 * feed it tool calls from the transcript rows or the `agent:tool-call`
 * hook.
 *
 * Native ACP tool calls carry `locations` from the adapter; MCP app tools
 * don't, so `upsertToolEntry` in agent-service.ts derives them from
 * `rawInput.path` instead. A write's diff items name their file too.
 */
import type { ToolCallUpdate } from "@notefig/shared/agent";

const ACTIVE_STATUSES = new Set(["pending", "in_progress"]);

/** The call is under way (not yet completed or failed). */
export function isActiveToolCall(toolCall: Pick<ToolCallUpdate, "status">): boolean {
  return !!toolCall.status && ACTIVE_STATUSES.has(toolCall.status);
}

/** The paths the call names, as given (absolute or workspace-relative). */
export function toolCallLocations(
  toolCall: Pick<ToolCallUpdate, "locations" | "content">,
): string[] {
  const paths = [
    ...(toolCall.locations ?? []).map((location) => location.path),
    ...(toolCall.content ?? []).flatMap((item) => (item.type === "diff" ? [item.path] : [])),
  ];
  return [...new Set(paths)];
}

/** Text the call is writing or replacing (its diff items), newest first. */
export function toolCallSnippets(toolCall: Pick<ToolCallUpdate, "content">): string[] {
  return (toolCall.content ?? []).flatMap((item) =>
    item.type === "diff" ? [item.newText, item.oldText ?? ""].filter(Boolean) : [],
  );
}
