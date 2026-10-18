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
import { FeedbackMessageEditor } from "./message-editor";

export const FEEDBACK_HOTKEY = "Mod+Shift+M";
/** What the Worker accepts. */
const MAX_MESSAGE = 5000;
/** The dialog's controls, a step smaller than the default button. */
const COMPACT_BUTTON = "h-7 px-2.5 text-xs";

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
      <DialogContent className="gap-3 p-5 sm:max-w-[36rem]">
        <DialogHeader className="space-y-1">
          <DialogTitle className="text-base">{t("sendFeedback")}</DialogTitle>
          <DialogDescription className="text-xs">
            {t("feedbackDescription")}
          </DialogDescription>
        </DialogHeader>
        {status === "sent" ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 rounded-md bg-muted/40 px-3 py-1.5 text-xs">
              <Check className="h-3.5 w-3.5 shrink-0 text-success" />
              {t("feedbackSent")}
            </div>
            <div className="flex justify-end">
              <Button
                size="sm"
                className={COMPACT_BUTTON}
                onClick={() => setOpen(false)}
              >
                {t("close")}
              </Button>
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
  const tooLong = message.length > MAX_MESSAGE;
  const error = tooLong
    ? t("feedbackTooLong")
    : status === "failed"
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
      <FeedbackMessageEditor
        initialMarkdown={message}
        placeholder={t("feedbackPlaceholder")}
        label={t("feedbackMessage")}
        readOnly={sending}
        onChange={onMessageChange}
      />
      {error && (
        <p role="alert" className="text-[11px] leading-snug text-destructive">
          {error}
        </p>
      )}
      <div className="flex items-center justify-between gap-3">
        <label className="flex min-w-0 cursor-pointer items-center gap-2">
          <Checkbox
            className="h-3.5 w-3.5"
            checked={includeDebug}
            onCheckedChange={(checked) => onIncludeDebugChange(checked === true)}
          />
          <span className="min-w-0 text-xs">
            {t("feedbackIncludeDebug")}
            <span className="block text-muted-foreground">
              {t("feedbackIncludeDebugDesc")}
            </span>
          </span>
        </label>
        <div className="flex shrink-0 gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={COMPACT_BUTTON}
            onClick={onCancel}
          >
            {t("cancel")}
          </Button>
          <Button
            type="submit"
            size="sm"
            className={COMPACT_BUTTON}
            disabled={sending || tooLong || !message.trim()}
          >
            {t(sending ? "feedbackSending" : "send")}
          </Button>
        </div>
      </div>
    </form>
  );
}
