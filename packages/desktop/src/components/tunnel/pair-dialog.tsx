import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, MonitorSmartphone, Wifi } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useTunnelConnection } from "@/hooks/use-tunnel-connection";
import {
  connectWithCode,
  disconnectTunnel,
  forgetPairing,
} from "@/agent/tunnel/connect-flow";
import {
  closePairDialog,
  usePairDialog,
} from "@/agent/tunnel/pair-dialog-store";

/**
 * The workspace-level "connect a machine" modal. Replaces the old `/pair`
 * route: pairing happens in place, so success just closes the dialog (no
 * navigation, no reload). Opening it while already paired shows the
 * connected state instead of a paste form, so a code is never re-submitted
 * into a live tunnel. A deep-link code (pair-dialog-store) opens it
 * pre-filled and auto-connects.
 */
export function PairDialog() {
  const { t } = useTranslation();
  const { open, prefillCode } = usePairDialog();
  const state = useTunnelConnection();

  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoConnected = useRef<string | null>(null);

  const connect = async (pairingCode: string) => {
    setSubmitting(true);
    setError(null);
    try {
      await connectWithCode(pairingCode);
      closePairDialog();
    } catch (connectError) {
      setError(
        connectError instanceof Error
          ? connectError.message
          : String(connectError),
      );
    } finally {
      setSubmitting(false);
    }
  };

  // Deep-link: auto-connect the pre-filled code once per open.
  useEffect(() => {
    if (!open || !prefillCode) return;
    if (autoConnected.current === prefillCode) return;
    autoConnected.current = prefillCode;
    void connect(prefillCode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, prefillCode]);

  // Reset transient input state each time the dialog opens fresh.
  useEffect(() => {
    if (!open) {
      setCode("");
      setError(null);
      autoConnected.current = null;
    }
  }, [open]);

  const connecting = submitting || state.status === "connecting";
  const connected = state.status === "connected";

  return (
    <Dialog open={open} onOpenChange={(next) => !next && closePairDialog()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {connected ? t("tunnelPairedTitle") : t("tunnelPairTitle")}
          </DialogTitle>
          <DialogDescription>
            {connected
              ? t("tunnelPairedWith", { host: state.workerInfo.name })
              : t("tunnelPairDescription")}
          </DialogDescription>
        </DialogHeader>

        {connected ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
              <Wifi className="h-4 w-4 text-green-500" />
              <span className="truncate">{state.workerInfo.workspacePath}</span>
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                onClick={() => {
                  disconnectTunnel();
                  void forgetPairing();
                }}
              >
                {t("tunnelPairDisconnect")}
              </Button>
              <Button onClick={() => closePairDialog()}>
                {t("tunnelPairDone")}
              </Button>
            </div>
          </div>
        ) : connecting ? (
          <div className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("tunnelPairConnecting")}
          </div>
        ) : (
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (code.trim()) void connect(code.trim());
            }}
          >
            <input
              autoFocus
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder={t("tunnelPairCodePlaceholder")}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
            <Button type="submit" className="w-full" disabled={!code.trim()}>
              <MonitorSmartphone className="mr-2 h-4 w-4" />
              {t("tunnelPairConnect")}
            </Button>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <p className="text-xs text-muted-foreground">{t("tunnelPairHint")}</p>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
