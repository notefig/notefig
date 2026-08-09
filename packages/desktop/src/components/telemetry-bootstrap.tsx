import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
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
    await platformAdapter.kv.getAllKv<unknown>(SETTINGS_NAMESPACE),
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
    // Fail closed: a flag missing despite the answered marker (partial
    // write, manual store edit) must read as declined, never accepted.
    crashEnabled: (stored["crashReportingEnabled"] as boolean) ?? false,
    analyticsEnabled: (stored["analyticsEnabled"] as boolean) ?? false,
    installId: (stored["telemetryInstallId"] as string | null) ?? null,
  };
}

async function ensureInstallId(
  existing: string | null,
  anyEnabled: boolean,
): Promise<string | null> {
  if (!anyEnabled || existing) return existing;
  const installId = crypto.randomUUID();
  await platformAdapter.kv.setKv(
    SETTINGS_NAMESPACE,
    "telemetryInstallId",
    installId,
  );
  return installId;
}

/**
 * Durable writes straight to the KV store. Write order is load-bearing:
 * `telemetryConsentVersion` is the "answered" marker and must land LAST,
 * so a partial failure can never leave consent looking answered while the
 * actual choices are missing (the dialog re-asks on the next launch).
 */
async function persistConsentAnswer(
  answer: TelemetryConsentAnswer,
  installId: string | null,
): Promise<void> {
  const entries: Array<[string, unknown]> = [
    ["crashReportingEnabled", answer.crashEnabled],
    ["analyticsEnabled", answer.analyticsEnabled],
  ];
  if (installId) entries.push(["telemetryInstallId", installId]);
  entries.push(["telemetryConsentVersion", CURRENT_TELEMETRY_CONSENT_VERSION]);
  for (const [key, value] of entries) {
    await platformAdapter.kv.setKv(SETTINGS_NAMESPACE, key, value);
  }
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

const NON_WORKSPACE_PATHS = new Set(["/", "/welcome", "/pair"]);

/** The consent dialog waits until the user is actually inside a workspace. */
function isWorkspaceRoute(pathname: string): boolean {
  return (
    !NON_WORKSPACE_PATHS.has(pathname) && !pathname.startsWith("/__harness")
  );
}

/**
 * App-global telemetry gate, mounted once in main.tsx (sibling of
 * AppUpdaterBootstrap). Registers global error handlers immediately, then
 * either configures telemetry from stored consent or arms the first-run
 * consent dialog. The dialog itself is deferred until the user has opened
 * a workspace — first contact (/welcome) stays prompt-free.
 */
export function TelemetryBootstrap() {
  const { setSetting } = useAppSettings();
  const location = useLocation();
  const [showConsent, setShowConsent] = useState(false);

  useEffect(() => {
    if (started) return;
    started = true;
    initGlobalErrorHandlers();
    void startTelemetry()
      .then((outcome) => {
        if (outcome === "show-consent") setShowConsent(true);
      })
      .catch((error) => {
        console.error("[telemetry] startup failed:", error);
        // Resolve the pending buffer as fully disabled instead of leaving
        // the module stuck in "pending" for the rest of the session.
        return configureTelemetry({
          crashEnabled: false,
          analyticsEnabled: false,
          installId: null,
        });
      });
  }, []);

  const handleAnswer = (answer: TelemetryConsentAnswer) => {
    setShowConsent(false);
    void (async () => {
      const anyEnabled = answer.crashEnabled || answer.analyticsEnabled;
      const installId = anyEnabled ? crypto.randomUUID() : null;
      try {
        await persistConsentAnswer(answer, installId);
        mirrorAnswerToSettings(setSetting, answer, installId);
      } catch (error) {
        // Honor the answer for this session regardless; the version
        // marker didn't land, so the dialog re-asks on the next launch.
        console.error("[telemetry] failed to persist consent:", error);
      }
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

  return (
    <TelemetryConsentDialog
      open={showConsent && isWorkspaceRoute(location.pathname)}
      onAnswer={handleAnswer}
    />
  );
}

/** Test-only: allow consent-flow tests to remount from a clean slate. */
export function __resetTelemetryBootstrapForTests() {
  started = false;
}
