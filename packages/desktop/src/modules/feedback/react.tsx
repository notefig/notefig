/**
 * The feedback dialog, mounted once in App, and its hotkey. Opened from
 * the command palette, Settings, or Mod+Shift+M anywhere in the app.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useHotkey } from "@tanstack/react-hotkeys";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@notefig/ui/dialog";
import { Button } from "@notefig/ui/button";
import { Checkbox } from "@notefig/ui/checkbox";
import { useCore } from "@notefig/core/react";
import { useDebugSnapshot } from "@/hooks/use-debug-snapshot";
import { formatDebugReport } from "@/utils/debug-report";
import type { FeedbackResult } from "./feedback";
import { MAX_IMAGES, messageLength } from "./images";
import { FeedbackMessageEditor } from "./message-editor";

export const FEEDBACK_HOTKEY = "Mod+Shift+M";
/** What the Worker accepts. */
const MAX_MESSAGE = 5000;
/** The dialog's controls, a step smaller than the default button. */
const COMPACT_BUTTON = "h-7 px-2.5 text-xs";

type Status = "idle" | "sending" | Exclude<FeedbackResult, "sent">;

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
 * Holds the draft, so it survives a close. Sending closes the dialog and
 * reports in a snackbar; a send that fails reopens the dialog on the
 * draft, with the error, for a retry.
 */
function FeedbackDialogShell() {
  const { t } = useTranslation();
  const { feedback } = useCore();
  const open = useFeedbackOpen();
  const [message, setMessage] = useState("");
  const [includeDebug, setIncludeDebug] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  // The editor reads the draft once, when it mounts; a new key after each
  // send remounts it empty if the dialog was reopened while sending.
  const [draftKey, setDraftKey] = useState(0);

  // A closed dialog's editor, and with it its undo history, is gone, so
  // the images its draft no longer shows can go too.
  useEffect(() => {
    if (!open) feedback.releaseImages(message);
  }, [feedback, open, message]);

  const setOpen = (next: boolean) => {
    if (next) feedback.open();
    else feedback.close();
  };

  useHotkey(FEEDBACK_HOTKEY, () => setOpen(!feedback.isOpen()));

  const send = async (debugReport: string | undefined) => {
    setStatus("sending");
    feedback.close();
    const toastId = toast.loading(t("feedbackSending"));
    const result = await feedback.send({ message, debugReport });
    if (result === "sent") {
      setMessage("");
      setDraftKey((key) => key + 1);
      setStatus("idle");
      toast.success(t("feedbackSent"), { id: toastId });
    } else {
      toast.dismiss(toastId);
      setStatus(result);
      feedback.open();
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {/* No description: the editor's placeholder says what to write. */}
      <DialogContent
        className="gap-3 p-5 sm:max-w-[36rem]"
        aria-describedby={undefined}
      >
        <DialogHeader>
          <DialogTitle className="text-base">{t("sendFeedback")}</DialogTitle>
        </DialogHeader>
        <FeedbackForm
          key={draftKey}
          message={message}
          onMessageChange={setMessage}
          includeDebug={includeDebug}
          onIncludeDebugChange={setIncludeDebug}
          status={status}
          onSend={send}
          onCancel={() => setOpen(false)}
        />
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
  const { feedback } = useCore();
  const snapshot = useDebugSnapshot();
  const sending = status === "sending";
  const tooLong = messageLength(message) > MAX_MESSAGE;
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
        onImage={feedback.addImage}
        maxImages={MAX_IMAGES}
        onTooManyImages={() =>
          toast.error(t("feedbackTooManyImages", { count: MAX_IMAGES }))
        }
      />
      {error && (
        <p role="alert" className="text-[11px] leading-snug text-destructive">
          {error}
        </p>
      )}
      <div className="flex items-center justify-between gap-3">
        <label
          className="flex min-w-0 cursor-pointer items-center gap-2 text-xs"
          title={t("feedbackIncludeDebugDesc")}
        >
          <Checkbox
            className="h-3.5 w-3.5"
            disabled={sending}
            checked={includeDebug}
            onCheckedChange={(checked) => onIncludeDebugChange(checked === true)}
          />
          {t("feedbackIncludeDebug")}
        </label>
        <FormActions
          status={status}
          canSend={!tooLong && message.trim() !== ""}
          onCancel={onCancel}
        />
      </div>
    </form>
  );
}

function FormActions({
  status,
  canSend,
  onCancel,
}: {
  status: Status;
  canSend: boolean;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const sending = status === "sending";
  return (
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
        disabled={sending || !canSend}
      >
        {t(sending ? "feedbackSending" : "send")}
      </Button>
    </div>
  );
}
