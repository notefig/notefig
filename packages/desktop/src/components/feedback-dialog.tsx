import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@notefig/ui/dialog";
import { Button } from "@notefig/ui/button";
import { Textarea } from "@notefig/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@notefig/ui/select";
import {
  OPEN_FEEDBACK_EVENT,
  sendFeedback,
  type FeedbackKind,
  type FeedbackResult,
} from "@/utils/feedback";

const MAX_MESSAGE = 5000;

/**
 * "Send Feedback", mounted once in App and opened from the command
 * palette. The draft survives a close, so a failed or interrupted send
 * can be retried; it clears once the Worker has it.
 */
export function FeedbackDialog({ supportUrl }: { supportUrl: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<FeedbackKind>("bug");
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | FeedbackResult>(
    "idle",
  );

  useEffect(() => {
    const handleOpen = () => {
      setStatus((current) => (current === "sent" ? "idle" : current));
      setOpen(true);
    };
    window.addEventListener(OPEN_FEEDBACK_EVENT, handleOpen);
    return () => window.removeEventListener(OPEN_FEEDBACK_EVENT, handleOpen);
  }, []);

  const send = async () => {
    setStatus("sending");
    const result = await sendFeedback(supportUrl, { kind, message });
    if (result === "sent") setMessage("");
    setStatus(result);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-[30rem]">
        <DialogHeader>
          <DialogTitle>{t("sendFeedback")}</DialogTitle>
          <DialogDescription>{t("feedbackDescription")}</DialogDescription>
        </DialogHeader>
        {status === "sent" ? (
          <>
            <p className="py-4 text-sm">{t("feedbackSent")}</p>
            <DialogFooter>
              <Button onClick={() => setOpen(false)}>{t("close")}</Button>
            </DialogFooter>
          </>
        ) : (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <Select
              value={kind}
              onValueChange={(value) => setKind(value as FeedbackKind)}
            >
              <SelectTrigger
                className="w-40"
                aria-label={t("feedbackKind")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="bug">{t("feedbackKindBug")}</SelectItem>
                <SelectItem value="idea">{t("feedbackKindIdea")}</SelectItem>
                <SelectItem value="other">{t("feedbackKindOther")}</SelectItem>
              </SelectContent>
            </Select>
            <Textarea
              autoFocus
              rows={6}
              maxLength={MAX_MESSAGE}
              value={message}
              readOnly={status === "sending"}
              placeholder={t("feedbackPlaceholder")}
              aria-label={t("feedbackMessage")}
              onChange={(e) => setMessage(e.target.value)}
            />
            {(status === "failed" || status === "rate-limited") && (
              <p role="alert" className="text-sm text-destructive">
                {t(status === "failed" ? "feedbackFailed" : "feedbackRateLimited")}
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setOpen(false)}
              >
                {t("cancel")}
              </Button>
              <Button
                type="submit"
                disabled={status === "sending" || !message.trim()}
              >
                {t(status === "sending" ? "feedbackSending" : "send")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
