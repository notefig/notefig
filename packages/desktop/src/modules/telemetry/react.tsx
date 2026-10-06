/**
 * The first-run consent dialog, mounted once in main.tsx (sibling of
 * AppUpdaterBootstrap). Deferred until the user has opened a workspace —
 * first contact (the welcome screen) stays prompt-free.
 */
import { useSyncExternalStore } from "react";
import { useFocusedWorkspace } from "@/modules/workspaces/react";
import { TelemetryConsentDialog } from "@/components/telemetry-consent-dialog";
import { useCore } from "@notefig/core/react";

export function TelemetryBootstrap() {
  const { telemetry } = useCore();
  const owed = useSyncExternalStore(telemetry.subscribe, telemetry.consentOwed);
  const insideWorkspace = useFocusedWorkspace() !== null;
  return (
    <TelemetryConsentDialog
      open={owed && insideWorkspace}
      onAnswer={telemetry.answer}
    />
  );
}
