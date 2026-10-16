import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  FEEDBACK_KINDS,
  FEEDBACK_MESSAGE_MAX,
  FEEDBACK_MESSAGE_MIN,
  type FeedbackKind,
} from "@notefig/shared/intake";
import { useCore } from "@notefig/core/react";
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
  closeFeedbackDialog,
  useFeedbackDialogOpen,
} from "@/hooks/use-feedback-dialog";
import { sendFeedback, type FeedbackSendResult } from "@/utils/feedback";

type Status = "idle" | "sending" | FeedbackSendResult;

/**
 * "Send feedback", mounted once in App when the build has an intake URL.
 * What's sent becomes a Linear Triage issue that syncs to public GitHub, so
 * the dialog says so up front.
 */
export function FeedbackDialog() {
  const { t } = useTranslation();
  const { kv } = useCore();
  const open = useFeedbackDialogOpen();
  const [kind, setKind] = useState<FeedbackKind>("bug");
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<Status>("idle");

  const close = () => {
    closeFeedbackDialog();
    setKind("bug");
    setMessage("");
    setStatus("idle");
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setStatus("sending");
    setStatus(await sendFeedback({ fetch: (...args) => fetch(...args), kv }, { kind, message }));
  };

  const tooShort = message.trim().length < FEEDBACK_MESSAGE_MIN;
  const sent = status === "sent";

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent className="sm:max-w-[30rem]">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{t("feedback.title")}</DialogTitle>
            <DialogDescription>{t("feedback.description")}</DialogDescription>
          </DialogHeader>
          {sent ? (
            <p className="py-4 text-sm" role="status">
              {t("feedback.sent")}
            </p>
          ) : (
            <div className="flex flex-col gap-3 py-4">
              <div role="group" aria-label={t("feedback.kind")} className="flex gap-2">
                {FEEDBACK_KINDS.map((option) => (
                  <Button
                    key={option}
                    type="button"
                    size="sm"
                    variant={option === kind ? "secondary" : "outline"}
                    aria-pressed={option === kind}
                    onClick={() => setKind(option)}
                  >
                    {t(`feedback.kinds.${option}`)}
                  </Button>
                ))}
              </div>
              <Textarea
                autoFocus
                aria-label={t("feedback.message")}
                placeholder={t("feedback.messagePlaceholder")}
                maxLength={FEEDBACK_MESSAGE_MAX}
                rows={6}
                value={message}
                onChange={(event) => setMessage(event.target.value)}
              />
              <StatusLine status={status} />
            </div>
          )}
          <DialogFooter>
            {sent ? (
              <Button type="button" onClick={close}>
                {t("close")}
              </Button>
            ) : (
              <>
                <Button type="button" variant="outline" onClick={close}>
                  {t("cancel")}
                </Button>
                <Button type="submit" disabled={tooShort || status === "sending"}>
                  {status === "sending" ? t("feedback.sending") : t("feedback.send")}
                </Button>
              </>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function StatusLine({ status }: { status: Status }) {
  const { t } = useTranslation();
  if (status === "limited") return <Alert>{t("feedback.limited")}</Alert>;
  if (status === "invalid") {
    return <Alert>{t("feedback.invalid", { min: FEEDBACK_MESSAGE_MIN })}</Alert>;
  }
  if (status === "failed") return <Alert>{t("feedback.failed")}</Alert>;
  return null;
}

function Alert({ children }: { children: string }) {
  return (
    <p className="text-sm text-destructive" role="alert">
      {children}
    </p>
  );
}
