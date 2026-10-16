import { useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import {
  DEBUG_REPORT_MAX,
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
import { Checkbox } from "@notefig/ui/checkbox";
import { Textarea } from "@notefig/ui/textarea";
import { useDebugSnapshot } from "@/hooks/use-debug-snapshot";
import {
  closeFeedbackDialog,
  useFeedbackDialogOpen,
} from "@/hooks/use-feedback-dialog";
import {
  formatDebugReport,
  trimDebugReport,
  type DebugSnapshot,
} from "@/utils/debug-report";
import { sendFeedback, type FeedbackSendResult } from "@/utils/feedback";

type Status = "idle" | "sending" | FeedbackSendResult;

/**
 * The debug panel's report as of now, cut to what the service takes. The
 * dialog has no console capture of its own, so the console section is
 * what the panel would show with capture off: none.
 */
function debugReportNow(snapshot: DebugSnapshot): string {
  const report = formatDebugReport({
    ...snapshot,
    rawUrl: window.location.pathname + window.location.search,
    userAgent: navigator.userAgent,
    now: new Date(),
    console: [],
  });
  return trimDebugReport(report, DEBUG_REPORT_MAX);
}

/**
 * "Send feedback", mounted once in App when the build has an intake URL.
 * What's sent becomes a Linear Triage issue that syncs to public GitHub, so
 * the dialog says so up front. The debug report is the exception: the
 * service keeps it private, and the user sees exactly what it holds before
 * choosing to include it.
 */
export function FeedbackDialog() {
  const { t } = useTranslation();
  const { kv } = useCore();
  const open = useFeedbackDialogOpen();
  const [kind, setKind] = useState<FeedbackKind>("bug");
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const debugReport = useDebugReportChoice();
  // Bumped on close, so a send that finishes after the dialog was closed
  // (and maybe reopened for a new draft) doesn't overwrite it.
  const session = useRef(0);

  const close = () => {
    session.current++;
    closeFeedbackDialog();
    setKind("bug");
    setMessage("");
    setStatus("idle");
    debugReport.include(false);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const sentIn = session.current;
    setStatus("sending");
    const result = await sendFeedback(
      { fetch: (...args) => fetch(...args), kv },
      { kind, message, debugReport: debugReport.report ?? undefined },
    );
    if (session.current === sentIn) setStatus(result);
  };

  const tooShort = message.trim().length < FEEDBACK_MESSAGE_MIN;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent className="sm:max-w-[30rem]">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{t("feedback.title")}</DialogTitle>
            <DialogDescription>{t("feedback.description")}</DialogDescription>
          </DialogHeader>
          {status === "sent" ? (
            <p className="py-4 text-sm" role="status">
              {t("feedback.sent")}
            </p>
          ) : (
            <div className="flex flex-col gap-3 py-4">
              <KindPicker kind={kind} onChange={setKind} />
              <Textarea
                autoFocus
                aria-label={t("feedback.message")}
                placeholder={t("feedback.messagePlaceholder")}
                maxLength={FEEDBACK_MESSAGE_MAX}
                rows={6}
                value={message}
                onChange={(event) => setMessage(event.target.value)}
              />
              <DebugReportOption choice={debugReport} />
              <StatusLine status={status} />
            </div>
          )}
          <FeedbackActions status={status} canSend={!tooShort} onClose={close} />
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Whether to include the debug report, and the report itself: taken when
 * the box is ticked, so what the preview shows is exactly what's sent.
 */
function useDebugReportChoice() {
  const [searchParams] = useSearchParams();
  const snapshot = useDebugSnapshot(searchParams);
  const [report, setReport] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  return {
    report,
    shown,
    include(checked: boolean) {
      setReport(checked ? debugReportNow(snapshot) : null);
      if (!checked) setShown(false);
    },
    toggleShown: () => setShown((current) => !current),
  };
}

function KindPicker({
  kind,
  onChange,
}: {
  kind: FeedbackKind;
  onChange: (kind: FeedbackKind) => void;
}) {
  const { t } = useTranslation();
  return (
    <div role="group" aria-label={t("feedback.kind")} className="flex gap-2">
      {FEEDBACK_KINDS.map((option) => (
        <Button
          key={option}
          type="button"
          size="sm"
          variant={option === kind ? "secondary" : "outline"}
          aria-pressed={option === kind}
          onClick={() => onChange(option)}
        >
          {t(`feedback.kinds.${option}`)}
        </Button>
      ))}
    </div>
  );
}

function DebugReportOption({ choice }: { choice: ReturnType<typeof useDebugReportChoice> }) {
  const { t } = useTranslation();
  const { report, shown } = choice;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <Checkbox
          id="feedback-debug-report"
          checked={report !== null}
          onCheckedChange={(checked) => choice.include(checked === true)}
        />
        <label htmlFor="feedback-debug-report" className="text-sm">
          {t("feedback.includeDebug")}
        </label>
        {report !== null && (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="ml-auto h-auto p-0"
            aria-expanded={shown}
            onClick={choice.toggleShown}
          >
            {shown ? t("feedback.hideDebug") : t("feedback.showDebug")}
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{t("feedback.debugHint")}</p>
      {report !== null && shown && (
        <pre
          aria-label={t("feedback.includeDebug")}
          className="max-h-48 overflow-auto rounded border border-border bg-muted p-2 text-[0.625rem] leading-tight whitespace-pre-wrap break-all select-text"
        >
          {report}
        </pre>
      )}
    </div>
  );
}

function FeedbackActions({
  status,
  canSend,
  onClose,
}: {
  status: Status;
  canSend: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  if (status === "sent") {
    return (
      <DialogFooter>
        <Button type="button" onClick={onClose}>
          {t("close")}
        </Button>
      </DialogFooter>
    );
  }
  return (
    <DialogFooter>
      <Button type="button" variant="outline" onClick={onClose}>
        {t("cancel")}
      </Button>
      <Button type="submit" disabled={!canSend || status === "sending"}>
        {status === "sending" ? t("feedback.sending") : t("feedback.send")}
      </Button>
    </DialogFooter>
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
