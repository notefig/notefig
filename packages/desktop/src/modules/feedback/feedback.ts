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
import { collectImages, encodeForUpload, type EncodeImage } from "./images";

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
   * Holds a pasted or dropped image for the draft, and gives back the URL
   * the editor shows it by. The message refers to it by that URL until it
   * is sent.
   */
  addImage(image: Blob): string;
  /**
   * Posts the message with the app's version and OS, and the images it
   * shows. Never throws: a network error, an image that won't encode, or
   * no answer within the timeout is "failed", so the dialog can keep the
   * draft and offer a retry. A sent draft's images are let go.
   */
  send(input: FeedbackInput): Promise<FeedbackResult>;
}

// Long enough for a few screenshots on a slow connection.
const SEND_TIMEOUT_MS = 30_000;
/** The Worker takes up to 50,000 characters; a longer report is cut here. */
const MAX_DEBUG_REPORT = 49_000;

export function createFeedback({
  supportUrl,
  fetchFn,
  timeoutMs = SEND_TIMEOUT_MS,
  encodeImage = encodeForUpload,
  objectUrls = URL,
}: {
  supportUrl: string | undefined;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  encodeImage?: EncodeImage;
  objectUrls?: Pick<typeof URL, "createObjectURL" | "revokeObjectURL">;
}): FeedbackApi {
  let open = false;
  const draftImages = new Map<string, Blob>();
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
    addImage(image) {
      const url = objectUrls.createObjectURL(image);
      draftImages.set(url, image);
      return url;
    },
    async send({ message, debugReport }) {
      if (supportUrl === undefined) return "failed";
      try {
        const sent = await collectImages(message, draftImages, encodeImage);
        // Multipart, so images travel as bytes: the Worker parses them
        // natively instead of decoding base64 out of JSON.
        const body = new FormData();
        body.append(
          "feedback",
          JSON.stringify({
            message: sent.message,
            version: __APP_VERSION__,
            os: getDesktopOs() ?? "web",
            ...(debugReport && { debugReport: truncate(debugReport) }),
          }),
        );
        for (const { id, image } of sent.attachments) {
          body.append(id, image, id);
        }
        const response = await (fetchFn ?? fetch)(
          new URL("/v1/feedback", supportUrl),
          { method: "POST", signal: AbortSignal.timeout(timeoutMs), body },
        );
        if (response.status === 429) return "rate-limited";
        if (!response.ok) return "failed";
        for (const url of draftImages.keys()) objectUrls.revokeObjectURL(url);
        draftImages.clear();
        return "sent";
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
