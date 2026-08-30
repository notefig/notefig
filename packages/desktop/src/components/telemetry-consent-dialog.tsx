import { useState } from "react";
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
import { Switch } from "@notefig/ui/switch";

export interface TelemetryConsentAnswer {
  crashEnabled: boolean;
  analyticsEnabled: boolean;
}

/**
 * First-run telemetry consent. Not dismissable — the app holds telemetry
 * in a memory buffer until this is answered (see src/telemetry/telemetry.ts),
 * so an unanswered dialog means nothing is ever sent.
 */
export function TelemetryConsentDialog({
  open,
  onAnswer,
}: {
  open: boolean;
  onAnswer: (answer: TelemetryConsentAnswer) => void;
}) {
  const { t } = useTranslation();
  const [crashEnabled, setCrashEnabled] = useState(true);
  const [analyticsEnabled, setAnalyticsEnabled] = useState(true);

  return (
    <Dialog open={open}>
      <DialogContent
        className="sm:max-w-[27.5rem]"
        showCloseButton={false}
        onOpenAutoFocus={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{t("telemetryConsentTitle")}</DialogTitle>
          <DialogDescription>{t("telemetryConsentBody")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 py-2">
          <ConsentRow
            label={t("telemetryCrashLabel")}
            description={t("telemetryCrashDescription")}
            checked={crashEnabled}
            onCheckedChange={setCrashEnabled}
          />
          <ConsentRow
            label={t("telemetryAnalyticsLabel")}
            description={t("telemetryAnalyticsDescription")}
            checked={analyticsEnabled}
            onCheckedChange={setAnalyticsEnabled}
          />
        </div>
        <DialogFooter className="flex-col gap-2 sm:flex-col">
          <Button
            className="w-full"
            onClick={() => onAnswer({ crashEnabled, analyticsEnabled })}
          >
            {t("telemetryConsentContinue")}
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            {t("telemetryConsentFootnote")}
          </p>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConsentRow({
  label,
  description,
  checked,
  onCheckedChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <p className="text-sm font-medium text-foreground">{label}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}
