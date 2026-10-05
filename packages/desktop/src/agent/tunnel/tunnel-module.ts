import { defineModule } from "@notefig/core";
import { isWeb } from "@/utils/platform";
import { createTunnelPairing, type TunnelPairingApi } from "./connect-flow";
import { hadDeepLinkPairing } from "./pair-dialog-store";
import { tunnelConnection } from "./tunnel-connection";

declare module "@notefig/core" {
  interface CoreModules {
    tunnel: TunnelPairingApi;
  }
}

/**
 * The tunnel pairing, as `core.tunnel`. Web only, at boot: reconnect to a
 * previously paired worker, and connect this tab when another one pairs.
 * Non-fatal — a stale pairing (worker restarted → new URL) just leaves the
 * tunnel disconnected and the status pill offers a re-pair.
 *
 * Skips the stored reconnect when this load carried a deep-link code: the
 * CLI-opened `/pair#<code>` tab has a FRESH code the dialog is about to
 * connect, and the stored pairing points at the previous (now-dead) port —
 * racing it would clobber the fresh connect with "could not reach the worker".
 */
export const tunnelModule = defineModule({
  name: "tunnel",
  needs: ["kv", "agents"],
  register: (ctx) =>
    createTunnelPairing({
      kv: ctx.use("kv"),
      connection: tunnelConnection,
      onDisconnect: () => ctx.use("agents").disposeAll(),
    }),
  boot: (tunnel) => {
    if (!isWeb()) return;
    if (!hadDeepLinkPairing) void tunnel.autoConnect();
    return tunnel.watchCrossTab();
  },
});
