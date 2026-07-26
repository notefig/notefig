import { useEffect, useState } from "react";
import {
  TelemetryConsentDialog,
  type TelemetryConsentAnswer,
} from "@/components/telemetry-consent-dialog";
import { platformAdapter } from "@/adapters";
import {
  CURRENT_TELEMETRY_CONSENT_VERSION,
  SETTINGS_NAMESPACE,
  useAppSettings,
} from "@/hooks/use-app-settings";
import {
  captureEvent,
  configureTelemetry,
  initGlobalErrorHandlers,
  telemetryAvailable,
} from "@/telemetry/telemetry";
// Module-level so StrictMode's double-mount can't re-run startup
// configuration or double-fire app_opened.
let started = false;

type SetAppSetting = ReturnType<typeof useAppSettings>["setSetting"];

function fireAppOpened() {
  captureEvent("app_opened");
}

/**
 * Consent state is read from and written to the platform KV store
 * DIRECTLY (not through the reactive settings collection) so the
 * shown-once decision never depends on collection hydration timing.
 * Returns whether the first-run consent dialog is still owed.
 */
async function startTelemetry(): Promise<"show-consent" | "done"> {
  if (!telemetryAvailable()) {
    // Keyless build: resolve the pending buffer as fully disabled and
    // never show the dialog — there is nothing to consent to.
    await configureTelemetry({
      crashEnabled: false,
      analyticsEnabled: false,
      installId: null,
    });
    return "done";
  }

  const consent = readStoredConsent(
    await platformAdapter.getAllKv<unknown>(SETTINGS_NAMESPACE),
  );
  if (!consent.answered) {
    return "show-consent";
  }

  const installId = await ensureInstallId(
    consent.installId,
    consent.crashEnabled || consent.analyticsEnabled,
  );
  await configureTelemetry({
    crashEnabled: consent.crashEnabled,
    analyticsEnabled: consent.analyticsEnabled,
    installId,
  });
  fireAppOpened();
  return "done";
}

function readStoredConsent(stored: Record<string, unknown>) {
  const consentVersion = (stored["telemetryConsentVersion"] as number) ?? 0;
  return {
    answered: consentVersion >= CURRENT_TELEMETRY_CONSENT_VERSION,
    crashEnabled: (stored["crashReportingEnabled"] as boolean) ?? true,
    analyticsEnabled: (stored["analyticsEnabled"] as boolean) ?? true,
    installId: (stored["telemetryInstallId"] as string | null) ?? null,
  };
}

async function ensureInstallId(
  existing: string | null,
  anyEnabled: boolean,
): Promise<string | null> {
  if (!anyEnabled || existing) return existing;
  const installId = crypto.randomUUID();
  await platformAdapter.setKv(
    SETTINGS_NAMESPACE,
    "telemetryInstallId",
    installId,
  );
  return installId;
}

/**
 * Durable writes straight to the KV store — awaited, so the shown-once
 * flag is on disk before anything else happens. Returns the install ID
 * (fresh when any tier was accepted).
 */
async function persistConsentAnswer(
  answer: TelemetryConsentAnswer,
): Promise<string | null> {
  const anyEnabled = answer.crashEnabled || answer.analyticsEnabled;
  const installId = anyEnabled ? crypto.randomUUID() : null;
  const entries: Array<[string, unknown]> = [
    ["telemetryConsentVersion", CURRENT_TELEMETRY_CONSENT_VERSION],
    ["crashReportingEnabled", answer.crashEnabled],
    ["analyticsEnabled", answer.analyticsEnabled],
  ];
  if (installId) entries.push(["telemetryInstallId", installId]);
  for (const [key, value] of entries) {
    await platformAdapter.setKv(SETTINGS_NAMESPACE, key, value);
  }
  return installId;
}

/**
 * Mirror the answer into the reactive collection so Settings → Privacy
 * shows it without a reload.
 */
function mirrorAnswerToSettings(
  setSetting: SetAppSetting,
  answer: TelemetryConsentAnswer,
  installId: string | null,
) {
  setSetting("crashReportingEnabled", answer.crashEnabled);
  setSetting("analyticsEnabled", answer.analyticsEnabled);
  setSetting("telemetryConsentVersion", CURRENT_TELEMETRY_CONSENT_VERSION);
  if (installId) setSetting("telemetryInstallId", installId);
}

/**
 * App-global telemetry gate, mounted once in main.tsx (sibling of
 * AppUpdaterBootstrap). Registers global error handlers immediately, then
 * either configures telemetry from stored consent or shows the first-run
 * consent dialog. Route-independent, so it works for both /welcome and
 * restored-workspace launches.
 */
export function TelemetryBootstrap() {
  const { setSetting } = useAppSettings();
  const [showConsent, setShowConsent] = useState(false);

  useEffect(() => {
    if (started) return;
    started = true;
    initGlobalErrorHandlers();
    void startTelemetry().then((outcome) => {
      if (outcome === "show-consent") setShowConsent(true);
    });
  }, []);

  const handleAnswer = (answer: TelemetryConsentAnswer) => {
    setShowConsent(false);
    void (async () => {
      const installId = await persistConsentAnswer(answer);
      mirrorAnswerToSettings(setSetting, answer, installId);
      await configureTelemetry({
        crashEnabled: answer.crashEnabled,
        analyticsEnabled: answer.analyticsEnabled,
        installId,
      });
      captureEvent("telemetry_consent_answered", {
        crash_enabled: answer.crashEnabled,
        analytics_enabled: answer.analyticsEnabled,
      });
      fireAppOpened();
    })();
  };

  return <TelemetryConsentDialog open={showConsent} onAnswer={handleAnswer} />;
}

/** Test-only: allow consent-flow tests to remount from a clean slate. */
export function __resetTelemetryBootstrapForTests() {
  started = false;
}
