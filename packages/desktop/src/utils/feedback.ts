import {
  FEEDBACK_WORKFLOW_ID,
  intakeSubmissionPath,
  type FeedbackKind,
  type FeedbackSubmission,
} from "@notefig/shared/intake";
import type { KvApi } from "@/modules/kv";
import { getDesktopOs } from "@/utils/platform";

/** Where feedback goes. Absent in dev and fork builds: no "Send feedback". */
const INTAKE_URL: string | undefined = import.meta.env.VITE_INTAKE_URL;

export function feedbackAvailable(): boolean {
  return Boolean(INTAKE_URL);
}

export type FeedbackSendResult = "sent" | "limited" | "invalid" | "failed";

export interface FeedbackDeps {
  fetch: typeof fetch;
  kv: Pick<KvApi, "read" | "write">;
  intakeUrl?: string;
}

const KV_NAMESPACE = "feedback";
const INSTALL_ID_KEY = "installId";

/**
 * An anonymous id for this install, used only for feedback (the service
 * hashes it to rate-limit and recognise repeat submitters). Separate from
 * the telemetry id, so feedback can't be joined to analytics.
 */
async function installId(kv: FeedbackDeps["kv"]): Promise<string> {
  const existing = await kv.read<string>(KV_NAMESPACE, INSTALL_ID_KEY);
  if (existing) return existing;
  const id = crypto.randomUUID();
  await kv.write(KV_NAMESPACE, INSTALL_ID_KEY, id);
  return id;
}

function resultFor(status: number): FeedbackSendResult {
  if (status === 202) return "sent";
  if (status === 429) return "limited";
  if (status === 400) return "invalid";
  return "failed";
}

export async function sendFeedback(
  deps: FeedbackDeps,
  input: { kind: FeedbackKind; message: string; debugReport?: string },
): Promise<FeedbackSendResult> {
  const intakeUrl = deps.intakeUrl ?? INTAKE_URL;
  if (!intakeUrl) return "failed";
  try {
    const submission: FeedbackSubmission = {
      kind: input.kind,
      message: input.message.trim(),
      app: { version: __APP_VERSION__, platform: getDesktopOs() ?? "web" },
      installId: await installId(deps.kv),
      ...(input.debugReport && { debugReport: input.debugReport }),
    };
    const response = await deps.fetch(
      new URL(intakeSubmissionPath(FEEDBACK_WORKFLOW_ID), intakeUrl),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(submission),
      },
    );
    return resultFor(response.status);
  } catch {
    return "failed";
  }
}
