import { z } from "zod";
import { verifyHmacSha256Hex } from "./crypto";
import type { LinearClient, LinearContext, StateType } from "./linear";
import type { HttpResult } from "./submit";
import type { Resolution, WorkflowStore } from "./store";
import type { Workflow } from "./workflow";

/**
 * Linear's Issue webhook, for the one moment the intake service acts on:
 * an approver moving a workflow's issue out of Triage.
 *
 * - Accept (any open state): the issue joins the workflow's project and
 *   gets its agent labels, which sync to GitHub and start agent-build.yml.
 *   Past the day's agent cap it only joins the project, with a comment.
 * - Decline (canceled): counts against the submitter, who is dropped after
 *   a few.
 * - Duplicate: recorded, no penalty.
 *
 * Moves by anyone not in LINEAR_APPROVER_IDS, issues without a workflow's
 * source label, and every other event are ignored. The service's own label
 * and project changes come back as webhooks too; they carry no state change,
 * so they are ignored the same way.
 */

const MAX_CLOCK_SKEW_MS = 60_000;

const envelopeSchema = z.object({
  type: z.string(),
  action: z.string(),
  webhookTimestamp: z.number(),
});

const issueUpdateSchema = z.object({
  type: z.literal("Issue"),
  action: z.literal("update"),
  actor: z.object({ id: z.string() }).optional(),
  data: z.object({
    id: z.string(),
    stateId: z.string(),
    labelIds: z.array(z.string()).default([]),
  }),
  updatedFrom: z.object({ stateId: z.string().optional() }).passthrough().optional(),
});

type IssueUpdate = z.infer<typeof issueUpdateSchema>;

export type WebhookOutcome = "ignored" | Resolution | "accepted-over-cap";

export interface WebhookDeps {
  secret: string;
  linear: LinearClient;
  store(workflowId: string): WorkflowStore;
  workflows: readonly Workflow[];
  approverIds: readonly string[];
  now(): number;
}

export async function handleLinearWebhook(
  deps: WebhookDeps,
  rawBody: string,
  signature: string | null,
): Promise<HttpResult> {
  if (!signature || !(await verifyHmacSha256Hex(deps.secret, rawBody, signature))) {
    return { status: 401, body: { error: "Bad signature" } };
  }
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { error: "Bad JSON" } };
  }
  const envelope = envelopeSchema.safeParse(json);
  if (!envelope.success) return { status: 400, body: { error: "Not a Linear webhook" } };
  if (Math.abs(deps.now() - envelope.data.webhookTimestamp) > MAX_CLOCK_SKEW_MS) {
    return { status: 401, body: { error: "Stale webhook" } };
  }
  const update = issueUpdateSchema.safeParse(json);
  const outcome = update.success ? await onIssueUpdate(deps, update.data) : "ignored";
  return { status: 200, body: { outcome } };
}

const RESOLUTIONS: Partial<Record<StateType, Resolution>> = {
  backlog: "accepted",
  unstarted: "accepted",
  started: "accepted",
  canceled: "declined",
  duplicate: "duplicate",
};

async function onIssueUpdate(deps: WebhookDeps, event: IssueUpdate): Promise<WebhookOutcome> {
  const previousStateId = event.updatedFrom?.stateId;
  if (!previousStateId || !event.actor || !deps.approverIds.includes(event.actor.id)) {
    return "ignored";
  }
  const context = await deps.linear.context();
  if (previousStateId !== context.triageStateId()) return "ignored";
  const workflow = deps.workflows.find((candidate) =>
    context.hasLabel(event.data.labelIds, candidate.linear.sourceLabel),
  );
  const resolution = RESOLUTIONS[context.stateType(event.data.stateId) ?? "triage"];
  if (!workflow || !resolution) return "ignored";

  const store = deps.store(workflow.id);
  await store.resolve(event.data.id, resolution);
  if (resolution !== "accepted") return resolution;
  return accept(deps.linear, context, store, workflow, event.data.id);
}

async function accept(
  linear: LinearClient,
  context: LinearContext,
  store: WorkflowStore,
  workflow: Workflow,
  issueId: string,
): Promise<WebhookOutcome> {
  const { agentLabels, project } = workflow.linear.onAccept;
  const projectId = project ? context.projectId(project) : undefined;
  if (await store.reserveAgentRun(workflow.limits.agentRunsPerDay)) {
    await linear.updateIssue(issueId, {
      addedLabelIds: agentLabels.map((name) => context.labelId(name)),
      projectId,
    });
    return "accepted";
  }
  if (projectId) await linear.updateIssue(issueId, { projectId });
  const labels = agentLabels.map((name) => `\`${name}\``).join(", ");
  await linear.comment(
    issueId,
    `Accepted. Today's cap of ${workflow.limits.agentRunsPerDay} agent builds is reached, ` +
      `so none was started. Add ${labels} to start one anyway.`,
  );
  return "accepted-over-cap";
}
