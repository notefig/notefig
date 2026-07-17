import { useTranslation } from "react-i18next";
import { Loader2, MonitorSmartphone, Wifi, WifiOff } from "lucide-react";
import { isWeb } from "@/utils/platform";
import { useTunnelConnection } from "@/hooks/use-tunnel-connection";
import { openPairDialog } from "@/agent/tunnel/pair-dialog-store";

/**
 * Remote-worker connection pill for the status bar. Web only — on desktop
 * agents run locally, so there's no tunnel. Every state opens the pairing
 * dialog on click (connect / manage / re-pair); the dialog is a workspace
 * modal, never a route.
 */
export function TunnelStatus() {
  const { t } = useTranslation();
  const state = useTunnelConnection();

  if (!isWeb()) return null;

  if (state.status === "connected") {
    return (
      <button
        type="button"
        onClick={() => openPairDialog()}
        className="flex items-center justify-center gap-2 hover:text-foreground"
      >
        <Wifi className="h-3.5 w-3.5 text-green-500" />
        <span>{t("tunnelStatusConnected", { host: state.workerInfo.name })}</span>
      </button>
    );
  }

  if (state.status === "connecting") {
    return (
      <div className="flex items-center justify-center gap-2">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-500" />
        <span>{t("tunnelStatusConnecting")}</span>
      </div>
    );
  }

  // Disconnected: a failed/lost pairing shows "re-pair"; a fresh session
  // shows a subtle "connect a machine" affordance so pairing is reachable
  // without a deep link.
  const hadPairing = Boolean(state.error);
  return (
    <button
      type="button"
      onClick={() => openPairDialog()}
      className="flex items-center justify-center gap-2 hover:text-foreground"
    >
      {hadPairing ? (
        <WifiOff className="h-3.5 w-3.5 text-destructive" />
      ) : (
        <MonitorSmartphone className="h-3.5 w-3.5" />
      )}
      <span>
        {hadPairing ? t("tunnelStatusReconnect") : t("tunnelConnectMachine")}
      </span>
    </button>
  );
}
