import { sha256Hex } from "./crypto";
import type { LinearClient } from "./linear";
import type { WorkflowStore } from "./store";
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
        await deps.linear
          .comment(admitted.issueId, submission.duplicateComment)
          .catch((error: unknown) => deps.warn("duplicate comment failed", error));
      }
      return ACCEPTED;
    case "create":
      await openIssue(deps, store, submission, submissionId);
      return ACCEPTED;
  }
}

async function openIssue(
  deps: SubmitDeps,
  store: WorkflowStore,
  submission: ParsedSubmission,
  submissionId: string,
): Promise<void> {
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
  } catch (error) {
    // Free the fingerprint so the same report can be retried.
    await store.abandon(submissionId);
    throw error;
  }
}
