/**
 * The graph view is a singleton — it represents the whole workspace, not a
 * per-item entity, so unlike agent chat tabs (agent-tab-id.ts) there's no
 * variable component to key on. One sentinel id, kept out of every
 * file-path code path (metadata queries, missing-file pruning) the same way
 * the `agent:` prefix is.
 */
export const GRAPH_TAB_ID = "graph:main";

export function isGraphTabId(tabId: string): boolean {
  return tabId === GRAPH_TAB_ID;
}
