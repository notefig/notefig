/**
 * The agent chat/activity panel: prompt input, streamed turn output
 * (message chunks coalesced per turn), inline tool-call diff cards, and the
 * permission queue. Reads agentTurns/agentEvents via useLiveQuery and talks
 * to the workspace's AgentService.
 */
export type AgentPanelProps = {
  workspacePath: string;
};

export function AgentPanel({ workspacePath }: AgentPanelProps) {
  // TODO(phase 1): useLiveQuery over agent collections + prompt box wired to
  // getWorkspaceAgentService(workspacePath)?.prompt(...).
  return <div data-workspace={workspacePath}>Agent panel (not implemented)</div>;
}
