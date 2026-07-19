/**
 * Agent chat tabs share the dockable layout with file tabs, whose ids are
 * workspace paths by convention. Agent tab ids are `agent:<taskId>` — the
 * prefix keeps them out of every file-path code path (metadata queries,
 * missing-file pruning, editor focus) without the dock layer caring.
 *
 * Moved here (from desktop's `utils/agent-tab-id.ts`, now a re-export) so
 * both desktop and this package's `TabHandle` share one definition of the
 * convention instead of duplicating the prefix logic.
 */
export const AGENT_TAB_PREFIX = "agent:";

export function agentTabId(taskId: string): string {
  return `${AGENT_TAB_PREFIX}${taskId}`;
}

export function isAgentTabId(tabId: string): boolean {
  return tabId.startsWith(AGENT_TAB_PREFIX);
}

export function agentTaskIdFromTabId(tabId: string): string | null {
  return isAgentTabId(tabId) ? tabId.slice(AGENT_TAB_PREFIX.length) : null;
}
