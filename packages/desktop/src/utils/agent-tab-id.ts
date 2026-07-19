/**
 * The `agent:<taskId>` tab-id convention now lives in `@metrists/workspace`
 * (shared with `TabHandle`'s agent-tab short-circuiting) — this re-export
 * keeps every existing `@/utils/agent-tab-id` import site unchanged.
 */
export {
  AGENT_TAB_PREFIX,
  agentTabId,
  isAgentTabId,
  agentTaskIdFromTabId,
} from "@metrists/workspace";
