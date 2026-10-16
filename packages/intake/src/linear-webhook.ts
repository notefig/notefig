import { z } from "zod";
import { AGENT_BUILD_LABEL, type BuildQueueRpc } from "./builds";
import { verifyHmacSha256Hex } from "./crypto";
import type { LinearClient, LinearContext, StateType } from "./linear";
import type { HttpResult } from "./submit";
import type { Resolution, WorkflowStore } from "./store";
import type { Workflow } from "./workflow";

/**
 * Linear's Issue webhook, for the moments the service acts on. Only an
 * approver's actions (LINEAR_APPROVER_IDS) count; anyone else's, and every
 * other event, are ignored.
 *
 * - An approver moves a workflow's issue out of Triage:
 *   - Accept (any open state): the issue joins the workflow's project and,
 *     under the day's cap, gets `agent:build` and a build.
 *   - Decline (canceled): counts against the submitter, who is dropped
 *     after a few.
 *   - Duplicate: recorded, no penalty.
 * - An approver adds `agent:build` to any issue, or creates one with it
 *   (the Agent build template): a build, uncapped.
 *
 * The service's own Linear writes come back as webhooks from the approver
 * whose API key it holds. Adding `agent:build` on Accept is one of them;
 * the build it asks for is already queued, so it changes nothing.
 */

const MAX_CLOCK_SKEW_MS = 60_000;

const envelopeSchema = z.object({
  type: z.string(),
  action: z.string(),
  webhookTimestamp: z.number(),
});

const issueEventSchema = z.object({
  type: z.literal("Issue"),
  action: z.enum(["create", "update"]),
  actor: z.object({ id: z.string() }).optional(),
  data: z.object({
    id: z.string(),
    stateId: z.string(),
    labelIds: z.array(z.string()).default([]),
  }),
  updatedFrom: z
    .object({ stateId: z.string().optional(), labelIds: z.array(z.string()).optional() })
    .passthrough()
    .optional(),
});

type IssueEvent = z.infer<typeof issueEventSchema>;

export type WebhookOutcome =
  | "ignored"
  | Resolution
  | "accepted-over-cap"
  | "build-started"
  | "build-queued"
  | "build-already";

export interface WebhookDeps {
  secret: string;
  linear: LinearClient;
  store(workflowId: string): WorkflowStore;
  builds: Pick<BuildQueueRpc, "request">;
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
  const event = issueEventSchema.safeParse(json);
  const outcome = event.success ? await onIssueEvent(deps, event.data) : "ignored";
  return { status: 200, body: { outcome } };
}

async function onIssueEvent(deps: WebhookDeps, event: IssueEvent): Promise<WebhookOutcome> {
  if (!event.actor || !deps.approverIds.includes(event.actor.id)) return "ignored";
  const context = await deps.linear.context();
  if (event.updatedFrom?.stateId === context.triageStateId()) {
    return onTriaged(deps, context, event);
  }
  if (addsBuildLabel(context, event)) return requestBuild(deps, event.data.id);
  return "ignored";
}

/** The event puts `agent:build` on the issue: created with it, or added. */
function addsBuildLabel(context: LinearContext, event: IssueEvent): boolean {
  if (!context.hasLabel(event.data.labelIds, AGENT_BUILD_LABEL)) return false;
  if (event.action === "create") return true;
  const before = event.updatedFrom?.labelIds;
  return before !== undefined && !context.hasLabel(before, AGENT_BUILD_LABEL);
}

const RESOLUTIONS: Partial<Record<StateType, Resolution>> = {
  backlog: "accepted",
  unstarted: "accepted",
  started: "accepted",
  canceled: "declined",
  duplicate: "duplicate",
};

async function onTriaged(
  deps: WebhookDeps,
  context: LinearContext,
  event: IssueEvent,
): Promise<WebhookOutcome> {
  const workflow = deps.workflows.find((candidate) =>
    context.hasLabel(event.data.labelIds, candidate.linear.sourceLabel),
  );
  const resolution = RESOLUTIONS[context.stateType(event.data.stateId) ?? "triage"];
  if (!workflow || !resolution) return "ignored";

  const store = deps.store(workflow.id);
  await store.resolve(event.data.id, resolution);
  if (resolution !== "accepted") return resolution;
  return accept(deps, context, store, workflow, event.data.id);
}

async function accept(
  deps: WebhookDeps,
  context: LinearContext,
  store: WorkflowStore,
  workflow: Workflow,
  issueId: string,
): Promise<WebhookOutcome> {
  const { build, project } = workflow.linear.onAccept;
  const projectId = project ? context.projectId(project) : undefined;
  const cap = workflow.limits.acceptedBuildsPerDay;
  if (build && (await store.reserveBuild(issueId, cap))) {
    await deps.linear.updateIssue(issueId, {
      addedLabelIds: [context.labelId(AGENT_BUILD_LABEL)],
      projectId,
    });
    await requestBuild(deps, issueId);
    return "accepted";
  }
  if (projectId) await deps.linear.updateIssue(issueId, { projectId });
  if (!build) return "accepted";
  await deps.linear.comment(
    issueId,
    `Accepted. Today's cap of ${cap} builds from accepted feedback is reached, so none was ` +
      `started. Add \`${AGENT_BUILD_LABEL}\` to start one anyway.`,
  );
  return "accepted-over-cap";
}

async function requestBuild(deps: WebhookDeps, issueId: string): Promise<WebhookOutcome> {
  const { identifier } = await deps.linear.issue(issueId);
  const result = await deps.builds.request({ issueId, identifier });
  return `build-${result}`;
}
