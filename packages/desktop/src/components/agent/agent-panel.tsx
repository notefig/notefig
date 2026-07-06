/**
 * The agent panel: a task list (create/switch/cancel — parallel tasks are
 * first-class), and per selected task a prompt input, streamed turn output
 * (message chunks coalesced per turn), inline tool-call diff cards, and
 * that task's permission queue. Reads the task-keyed collections via
 * useLiveQuery and talks to the workspace's TaskManager. Overlap warnings
 * ("two tasks are editing pricing.md") surface from
 * TaskManager.writeGate.getRecentWriters.
 */
export type AgentPanelProps = {
  workspacePath: string;
};

export function AgentPanel({ workspacePath }: AgentPanelProps) {
  // TODO(phase 1): task list over agentTasksCollection; prompt box wired to
  // getOrCreateWorkspaceTaskManager(workspacePath).getTask(active)?.prompt(...).
  return <div data-workspace={workspacePath}>Agent panel (not implemented)</div>;
}
