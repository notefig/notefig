/**
 * Feedback — `core.feedback`: whether the "Send Feedback" dialog is open,
 * and the send to support.notefig.com (`workers/support`).
 *
 * Every way in (the command palette, the hotkey, Settings) calls `open()`;
 * the one dialog, mounted in App, follows `isOpen()`. Builds without a
 * support URL (dev, forks, the marketing site) are `available: false` and
 * offer no way in.
 */
import { defineModule } from "@notefig/core";
import { getDesktopOs } from "@/utils/platform";

export type FeedbackResult = "sent" | "rate-limited" | "failed";

export interface FeedbackInput {
  message: string;
  /** The debug panel's report, when the user chose to attach it. */
  debugReport?: string;
}

export interface FeedbackApi {
  readonly available: boolean;
  isOpen(): boolean;
  subscribe(listener: () => void): () => void;
  open(): void;
  close(): void;
  /**
   * Posts the message with the app's version and OS. Never throws: a
   * network error, or no answer within the timeout, is "failed", so the
   * dialog can keep the draft and offer a retry.
   */
  send(input: FeedbackInput): Promise<FeedbackResult>;
}

const SEND_TIMEOUT_MS = 15_000;
/** The Worker takes up to 50,000 characters; a longer report is cut here. */
const MAX_DEBUG_REPORT = 49_000;

export function createFeedback({
  supportUrl,
  fetchFn,
  timeoutMs = SEND_TIMEOUT_MS,
}: {
  supportUrl: string | undefined;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}): FeedbackApi {
  let open = false;
  const listeners = new Set<() => void>();
  const setOpen = (next: boolean) => {
    if (open === next) return;
    open = next;
    for (const listener of [...listeners]) listener();
  };

  return {
    available: supportUrl !== undefined,
    isOpen: () => open,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    open: () => setOpen(true),
    close: () => setOpen(false),
    async send({ message, debugReport }) {
      if (supportUrl === undefined) return "failed";
      try {
        const response = await (fetchFn ?? fetch)(
          new URL("/v1/feedback", supportUrl),
          {
            method: "POST",
            signal: AbortSignal.timeout(timeoutMs),
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              message,
              version: __APP_VERSION__,
              os: getDesktopOs() ?? "web",
              ...(debugReport && { debugReport: truncate(debugReport) }),
            }),
          },
        );
        if (response.status === 429) return "rate-limited";
        return response.ok ? "sent" : "failed";
      } catch {
        return "failed";
      }
    },
  };
}

function truncate(report: string): string {
  return report.length <= MAX_DEBUG_REPORT
    ? report
    : `${report.slice(0, MAX_DEBUG_REPORT)}\n… (truncated)`;
}

declare module "@notefig/core" {
  interface CoreModules {
    feedback: FeedbackApi;
  }
}

export const feedbackModule = defineModule({
  name: "feedback",
  register: () =>
    createFeedback({
      supportUrl: import.meta.env.VITE_SUPPORT_URL || undefined,
    }),
});
