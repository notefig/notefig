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
