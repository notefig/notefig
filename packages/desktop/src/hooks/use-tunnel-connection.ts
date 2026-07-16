import { useSyncExternalStore } from "react";
import { tunnelConnection } from "@/agent/tunnel/tunnel-connection";
import type { TunnelConnectionState } from "@/agent/tunnel/tunnel-connection";

/** Reactive tunnel connection state for the connect UI / status surface. */
export function useTunnelConnection(): TunnelConnectionState {
  return useSyncExternalStore(
    (listener) => tunnelConnection.subscribe(listener),
    () => tunnelConnection.getState(),
    () => tunnelConnection.getState(),
  );
}
