/**
 * Whether this build runs the scripted mock harness instead of real agents
 * (`VITE_AGENT_MOCK=1`, the e2e builds). A leaf, so the gates that check it
 * import nothing of the harness itself.
 */
export const MOCK_AGENT_MODE = import.meta.env.VITE_AGENT_MOCK === "1";
