/**
 * Open/close state for the "connect a machine" dialog — a workspace-level
 * modal, not a route, so pairing never navigates or reloads. A deep-link
 * pairing code (`.../pair#<code>` or `/#<code>`) is captured from the URL
 * fragment ONCE at module load and scrubbed immediately (the secret must not
 * linger in history), then the dialog opens pre-filled to auto-connect.
 */
import { useSyncExternalStore } from "react";
import { decodePairingCode } from "@metrists/shared/tunnel";

export type PairDialogState = { open: boolean; prefillCode?: string };

let state: PairDialogState = { open: false };
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/**
 * A valid pairing code out of a URL fragment, or null. Kept here (not
 * imported from connect-flow) so this store — loaded very early, at module
 * import — doesn't pull in connect-flow's heavy agent-service graph.
 */
function pairingCodeFromHash(hash: string): string | null {
  const code = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!code) return null;
  try {
    decodePairingCode(code);
    return code;
  } catch {
    return null;
  }
}

// Capture a fragment-carried code before anything renders, and scrub it.
const bootCode =
  typeof window !== "undefined"
    ? pairingCodeFromHash(window.location.hash)
    : null;
if (bootCode) {
  window.history.replaceState(
    null,
    "",
    window.location.pathname + window.location.search,
  );
  state = { open: true, prefillCode: bootCode };
}

/**
 * True when this page load carried a deep-link pairing code (a CLI-opened
 * `/pair#<code>` tab). The dialog will auto-connect that fresh code, so boot
 * must NOT also fire the stored auto-reconnect — the stored pairing points at
 * the previous worker's port (the CLI mints a new one each run), and racing it
 * would tear down the fresh connect and dial the dead port ("could not reach
 * the worker").
 */
export const hadDeepLinkPairing = bootCode !== null;

export function openPairDialog(prefillCode?: string): void {
  state = { open: true, prefillCode };
  emit();
}

export function closePairDialog(): void {
  state = { open: false };
  emit();
}

export function usePairDialog(): PairDialogState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
    () => state,
  );
}
