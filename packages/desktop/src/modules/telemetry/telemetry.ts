import { defineModule } from "@notefig/core";
import { type TelemetryConsentAnswer } from "@/components/telemetry-consent-dialog";
import type { KvApi } from "@/modules/kv";
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
import { kvModule } from "@/modules/kv";
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
async function startTelemetry(kv: KvApi): Promise<"show-consent" | "done"> {
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
    await kv.readAll<unknown>(SETTINGS_NAMESPACE),
  );
  if (!consent.answered) {
    return "show-consent";
  }

  const installId = await ensureInstallId(
    kv,
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
  kv: KvApi,
  existing: string | null,
  anyEnabled: boolean,
): Promise<string | null> {
  if (!anyEnabled || existing) return existing;
  const installId = crypto.randomUUID();
  await kv.write(SETTINGS_NAMESPACE, "telemetryInstallId", installId);
  return installId;
}

/**
 * Write order is load-bearing:
 * `telemetryConsentVersion` is the "answered" marker and must land LAST,
 * so a partial failure can never leave consent looking answered while the
 * actual choices are missing (the dialog re-asks on the next launch).
 */
async function persistConsentAnswer(
  kv: KvApi,
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
    await kv.write(SETTINGS_NAMESPACE, key, value);
  }
}

/** `core.telemetry`: whether the first-run consent is still owed, and
 *  the user's answer to it. */
export interface TelemetryApi {
  /** Registers global error handlers, then either configures telemetry
   *  from stored consent or arms the first-run consent dialog. Boot runs
   *  this, once. */
  start(): void;
  consentOwed(): boolean;
  subscribe(listener: () => void): () => void;
  answer(answer: TelemetryConsentAnswer): void;
}

function createTelemetry(kv: KvApi): TelemetryApi {
  let owed = false;
  const listeners = new Set<() => void>();
  const setOwed = (next: boolean) => {
    owed = next;
    for (const listener of [...listeners]) listener();
  };
  return {
    consentOwed: () => owed,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    start() {
      initGlobalErrorHandlers();
      void startTelemetry(kv)
        .then((outcome) => {
          if (outcome === "show-consent") setOwed(true);
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
    },
    answer(answer) {
      setOwed(false);
      void (async () => {
        const anyEnabled = answer.crashEnabled || answer.analyticsEnabled;
        // Reuse a stored ID so a consent-version bump (which re-shows this
        // dialog) doesn't rotate the install identity, matching the
        // Settings toggles' behavior.
        const installId = anyEnabled
          ? ((await kv.read<string>(
              SETTINGS_NAMESPACE,
              "telemetryInstallId",
            )) ?? crypto.randomUUID())
          : null;
        try {
          // Settings → Privacy picks this up without a reload: the write
          // goes through the same collection `useAppSettings` subscribes to.
          await persistConsentAnswer(kv, answer, installId);
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
    },
  };
}

declare module "@notefig/core" {
  interface CoreModules {
    telemetry: TelemetryApi;
  }
}

/** Telemetry for the app's run: configured from stored consent at boot,
 *  once — StrictMode remounts never re-run it or double-fire app_opened. */
export const telemetryModule = defineModule({
  name: "telemetry",
  needs: [kvModule],
  register: (ctx) => createTelemetry(ctx.use("kv")),
  boot: (telemetry) => telemetry.start(),
});
