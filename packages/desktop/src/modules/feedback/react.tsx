/**
 * The feedback dialog, mounted once in App, and its hotkey. Opened from
 * the command palette, Settings, or Mod+Shift+M anywhere in the app.
 */
import { useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useHotkey } from "@tanstack/react-hotkeys";
import { Check } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@notefig/ui/dialog";
import { Button } from "@notefig/ui/button";
import { Checkbox } from "@notefig/ui/checkbox";
import { useCore } from "@notefig/core/react";
import { useDebugSnapshot } from "@/hooks/use-debug-snapshot";
import { formatDebugReport } from "@/utils/debug-report";
import type { FeedbackResult } from "./feedback";

export const FEEDBACK_HOTKEY = "Mod+Shift+M";
const MAX_MESSAGE = 5000;

type Status = "idle" | "sending" | FeedbackResult;

/** Whether the feedback dialog is open, live. */
export function useFeedbackOpen(): boolean {
  const { feedback } = useCore();
  return useSyncExternalStore(feedback.subscribe, feedback.isOpen);
}

/** Nothing in builds without a support URL. */
export function FeedbackDialog() {
  const { feedback } = useCore();
  return feedback.available ? <FeedbackDialogShell /> : null;
}

/**
 * Holds the draft, so it survives a close: a failed or interrupted send
 * can be retried, and it clears once the Worker has it.
 */
function FeedbackDialogShell() {
  const { t } = useTranslation();
  const { feedback } = useCore();
  const open = useFeedbackOpen();
  const [message, setMessage] = useState("");
  const [includeDebug, setIncludeDebug] = useState(false);
  const [status, setStatus] = useState<Status>("idle");

  // Reopening after a send starts a fresh form, whichever way it opened
  // (the hotkey, the palette, Settings): adjusted during render, on the
  // open it follows.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open && status === "sent") setStatus("idle");
  }

  const setOpen = (next: boolean) => {
    if (next) feedback.open();
    else feedback.close();
  };

  useHotkey(FEEDBACK_HOTKEY, () => setOpen(!feedback.isOpen()));

  const send = async (debugReport: string | undefined) => {
    setStatus("sending");
    const result = await feedback.send({ message, debugReport });
    if (result === "sent") setMessage("");
    setStatus(result);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-[28rem]">
        <DialogHeader>
          <DialogTitle>{t("sendFeedback")}</DialogTitle>
          <DialogDescription>{t("feedbackDescription")}</DialogDescription>
        </DialogHeader>
        {status === "sent" ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
              <Check className="h-4 w-4 shrink-0 text-success" />
              {t("feedbackSent")}
            </div>
            <div className="flex justify-end">
              <Button onClick={() => setOpen(false)}>{t("close")}</Button>
            </div>
          </div>
        ) : (
          <FeedbackForm
            message={message}
            onMessageChange={setMessage}
            includeDebug={includeDebug}
            onIncludeDebugChange={setIncludeDebug}
            status={status}
            onSend={send}
            onCancel={() => setOpen(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The form, mounted only while the dialog is open: the debug snapshot it
 * reads follows the query cache, which a closed dialog has no reason to.
 */
function FeedbackForm({
  message,
  onMessageChange,
  includeDebug,
  onIncludeDebugChange,
  status,
  onSend,
  onCancel,
}: {
  message: string;
  onMessageChange: (message: string) => void;
  includeDebug: boolean;
  onIncludeDebugChange: (include: boolean) => void;
  status: Status;
  onSend: (debugReport: string | undefined) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const snapshot = useDebugSnapshot();
  const sending = status === "sending";
  const error =
    status === "failed"
      ? t("feedbackFailed")
      : status === "rate-limited"
        ? t("feedbackRateLimited")
        : null;

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSend(includeDebug ? formatDebugReport(snapshot) : undefined);
      }}
    >
      <textarea
        autoFocus
        rows={6}
        maxLength={MAX_MESSAGE}
        value={message}
        readOnly={sending}
        placeholder={t("feedbackPlaceholder")}
        aria-label={t("feedbackMessage")}
        onChange={(event) => onMessageChange(event.target.value)}
        className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
      />
      <label className="flex cursor-pointer items-start gap-3">
        <Checkbox
          className="mt-0.5"
          checked={includeDebug}
          onCheckedChange={(checked) => onIncludeDebugChange(checked === true)}
        />
        <span className="min-w-0">
          <span className="block text-sm font-medium">
            {t("feedbackIncludeDebug")}
          </span>
          <span className="block text-xs text-muted-foreground">
            {t("feedbackIncludeDebugDesc")}
          </span>
        </span>
      </label>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t("cancel")}
        </Button>
        <Button type="submit" disabled={sending || !message.trim()}>
          {t(sending ? "feedbackSending" : "send")}
        </Button>
      </div>
    </form>
  );
}
