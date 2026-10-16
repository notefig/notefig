/**
 * Open state for the "Send feedback" dialog, a modal mounted once in App
 * and opened from the command palette.
 */
import { useSyncExternalStore } from "react";

let open = false;
const listeners = new Set<() => void>();

function setOpen(next: boolean): void {
  open = next;
  for (const listener of listeners) listener();
}

export function openFeedbackDialog(): void {
  setOpen(true);
}

export function closeFeedbackDialog(): void {
  setOpen(false);
}

export function useFeedbackDialogOpen(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => open,
    () => open,
  );
}
