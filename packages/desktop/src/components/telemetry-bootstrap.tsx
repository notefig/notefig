import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import {
  TelemetryConsentDialog,
  type TelemetryConsentAnswer,
} from "@/components/telemetry-consent-dialog";
import { readAllKv, writeKv } from "@/utils/kv-store";
import {
  CURRENT_TELEMETRY_CONSENT_VERSION,
  SETTINGS_NAMESPACE,
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

function fireAppOpened() {
  captureEvent("app_opened");
}

/**
 * Reads consent straight from storage rather than from `useAppSettings`, so
 * the shown-once decision never depends on React render timing. Since MET-124
 * that read hydrates the same collection the hook subscribes to, so the two
 * can no longer disagree.
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
    await readAllKv<unknown>(SETTINGS_NAMESPACE),
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
  await writeKv(SETTINGS_NAMESPACE, "telemetryInstallId", installId);
  return installId;
}

/**
 * Write order is load-bearing:
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
    await writeKv(SETTINGS_NAMESPACE, key, value);
  }
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
        // Settings → Privacy picks this up without a reload: the write goes
        // through the same collection `useAppSettings` subscribes to.
        await persistConsentAnswer(answer, installId);
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
