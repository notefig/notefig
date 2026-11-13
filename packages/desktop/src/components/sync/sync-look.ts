/**
 * How a sync state reads, wherever it's drawn (the status-bar cell, the
 * Remote tool): an icon, a label key, a tone. A leaf, so both can import it
 * without one pulling the other's React tree.
 */
import { AlertTriangle, CloudOff, GitBranch, KeyRound, Loader2, PauseCircle, type LucideIcon } from "lucide-react";
import type { SyncState } from "@/modules/sync";

export interface SyncLook {
  icon: LucideIcon;
  label: string;
  tone?: string;
  spin?: boolean;
}

export function lookOf(state: SyncState): SyncLook {
  if (state.setup === "off" || state.setup === "unavailable") return { icon: CloudOff, label: "syncOff" };
  if (state.setup !== "on") return { icon: CloudOff, label: "syncNotSyncing", tone: "text-warning" };
  switch (state.fault) {
    case "offline":
      return { icon: CloudOff, label: "syncOffline", tone: "text-warning" };
    case "throttled":
      return { icon: CloudOff, label: "syncThrottled", tone: "text-warning" };
    case "auth-error":
      return { icon: KeyRound, label: "syncAuthError", tone: "text-destructive" };
    case "diverged":
      return { icon: AlertTriangle, label: "syncStopped", tone: "text-destructive" };
    case "paused":
      return { icon: PauseCircle, label: "syncPaused", tone: "text-warning" };
  }
  if (state.activity === "idle") return { icon: GitBranch, label: "syncSynced", tone: "text-success" };
  return { icon: Loader2, label: `sync-${state.activity}`, spin: true };
}

/** One word for the state, for tests and styling hooks. */
export function statusOf(state: SyncState): string {
  return state.setup === "on" ? (state.fault ?? state.activity) : state.setup;
}
