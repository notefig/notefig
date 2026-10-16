/**
 * The intake service (packages/intake) takes submissions per workflow at
 * one path each. A workflow id is permanent: it names the path and the
 * Durable Object that holds the workflow's state.
 */
export function intakeSubmissionPath(workflowId: string): string {
  return `/v1/workflows/${encodeURIComponent(workflowId)}/submissions`;
}
