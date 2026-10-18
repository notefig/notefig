import { getDesktopOs } from "@/utils/platform";

export type FeedbackKind = "bug" | "idea" | "other";
export type FeedbackResult = "sent" | "rate-limited" | "failed";

/**
 * support.notefig.com's base URL. Absent in builds that ship without
 * feedback (dev, forks, the marketing demo), which then offer no
 * "Send Feedback" command.
 */
export const supportUrl: string | undefined =
  import.meta.env.VITE_SUPPORT_URL || undefined;

export const OPEN_FEEDBACK_EVENT = "open-feedback-dialog";

/** Opens the <FeedbackDialog /> mounted in App. */
export function openFeedbackDialog(): void {
  window.dispatchEvent(new Event(OPEN_FEEDBACK_EVENT));
}

const SEND_TIMEOUT_MS = 15_000;

/**
 * Posts one piece of feedback to the support Worker, with the app's
 * version and OS. Never throws: a network error, or no answer within
 * `timeoutMs`, is "failed", so the dialog can keep the draft and offer a
 * retry.
 */
export async function sendFeedback(
  baseUrl: string,
  feedback: { kind: FeedbackKind; message: string },
  fetchFn: typeof fetch = fetch,
  timeoutMs = SEND_TIMEOUT_MS,
): Promise<FeedbackResult> {
  try {
    const response = await fetchFn(new URL("/v1/feedback", baseUrl), {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...feedback,
        version: __APP_VERSION__,
        os: getDesktopOs() ?? "web",
      }),
    });
    if (response.status === 429) return "rate-limited";
    return response.ok ? "sent" : "failed";
  } catch {
    return "failed";
  }
}
