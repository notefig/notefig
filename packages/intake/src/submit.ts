import { sha256Hex } from "./crypto";
import type { LinearClient } from "./linear";
import { REPORT_RETENTION_DAYS, type WorkflowStore } from "./store";
import type { ParsedSubmission, Workflow } from "./workflow";

export interface HttpResult {
  status: number;
  body: Record<string, unknown>;
}

export interface SubmitDeps {
  linear: LinearClient;
  store(workflowId: string): WorkflowStore;
  /** Secret salt for hashing fingerprints and submitter ids. */
  salt: string;
  newId(): string;
  /** Where a stored report is read (behind Cloudflare Access). */
  reportUrl(workflowId: string, reportId: string): string;
  warn(message: string, error: unknown): void;
}

/**
 * Every accepted outcome looks the same to the client — new issue,
 * duplicate, blocked submitter — so the response says nothing about how a
 * submission was treated.
 */
const ACCEPTED: HttpResult = { status: 202, body: { ok: true } };
const LIMITED: HttpResult = {
  status: 429,
  body: { error: "Too many submissions today. Please try again tomorrow." },
};

/**
 * Takes one submission for `workflow`: dedupes and rate-limits it through
 * the workflow's store, then opens a Linear Triage issue or comments on the
 * one it duplicates. `fallbackSubmitter` (the client IP) stands in when the
 * payload carries no submitter id.
 */
export async function handleSubmission(
  deps: SubmitDeps,
  workflow: Workflow,
  body: unknown,
  fallbackSubmitter: string,
): Promise<HttpResult> {
  const parsed = workflow.parse(body);
  if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
  const { submission } = parsed;

  const submissionId = deps.newId();
  const store = deps.store(workflow.id);
  const admitted = await store.admit({
    submissionId,
    fingerprint: await sha256Hex(`${deps.salt}:${workflow.id}:${submission.fingerprint}`),
    submitter: await sha256Hex(`${deps.salt}:${submission.submitter ?? fallbackSubmitter}`),
    limits: workflow.limits,
  });

  switch (admitted.kind) {
    case "limited":
      return LIMITED;
    case "drop":
      return ACCEPTED;
    case "duplicate":
      if (admitted.issueId) {
        const issueId = admitted.issueId;
        await deps.linear
          .comment(issueId, submission.duplicateComment)
          .catch((error: unknown) => deps.warn("duplicate comment failed", error));
        await attachReport(deps, store, workflow, submission, admitted.submissionId, issueId);
      }
      return ACCEPTED;
    case "create": {
      const issueId = await openIssue(deps, store, submission, submissionId);
      await attachReport(deps, store, workflow, submission, submissionId, issueId);
      return ACCEPTED;
    }
  }
}

/**
 * Stores the submission's private report and links it from the issue. The
 * issue already exists, so a failure here only loses the report.
 */
async function attachReport(
  deps: SubmitDeps,
  store: WorkflowStore,
  workflow: Workflow,
  submission: ParsedSubmission,
  submissionId: string,
  issueId: string,
): Promise<void> {
  if (!submission.report) return;
  try {
    const reportId = await store.saveReport(submissionId, submission.report);
    await deps.linear.attach(issueId, {
      url: deps.reportUrl(workflow.id, reportId),
      title: workflow.linear.reportTitle ?? "Report",
      subtitle: `Private. Deleted after ${REPORT_RETENTION_DAYS} days, or when the issue is declined.`,
    });
  } catch (error) {
    deps.warn("report attachment failed", error);
  }
}

async function openIssue(
  deps: SubmitDeps,
  store: WorkflowStore,
  submission: ParsedSubmission,
  submissionId: string,
): Promise<string> {
  try {
    const context = await deps.linear.context();
    const draft = submission.issue(submissionId);
    const issue = await deps.linear.createIssue({
      teamId: context.teamId,
      stateId: context.triageStateId(),
      title: draft.title,
      description: draft.description,
      labelIds: draft.labels.map((name) => context.labelId(name)),
    });
    await store.linkIssue(submissionId, issue.id);
    return issue.id;
  } catch (error) {
    // Free the fingerprint so the same report can be retried.
    await store.abandon(submissionId);
    throw error;
  }
}
