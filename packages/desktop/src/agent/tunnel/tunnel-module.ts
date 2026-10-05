import { defineModule } from "@notefig/core";
import { isWeb } from "@/utils/platform";
import { autoConnectStoredPairing, watchCrossTabPairing } from "./connect-flow";
import { hadDeepLinkPairing } from "./pair-dialog-store";

/**
 * Web only: reconnect to a previously paired worker on boot, and connect
 * this tab when another one pairs. Non-fatal — a stale pairing (worker
 * restarted → new URL) just leaves the tunnel disconnected and the status
 * pill offers a re-pair.
 *
 * Skips the stored reconnect when this load carried a deep-link code: the
 * CLI-opened `/pair#<code>` tab has a FRESH code the dialog is about to
 * connect, and the stored pairing points at the previous (now-dead) port —
 * racing it would clobber the fresh connect with "could not reach the worker".
 */
export const tunnelModule = defineModule({
  name: "tunnel",
  boot: () => {
    if (!isWeb()) return;
    if (!hadDeepLinkPairing) void autoConnectStoredPairing();
    return watchCrossTabPairing();
  },
});
