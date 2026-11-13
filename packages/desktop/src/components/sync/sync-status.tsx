/**
 * Sync in the status bar, for the focused workspace: its state, at a
 * glance. Pressing it opens the workspace's Remote tool in the sidebar
 * (`remote-panel.tsx`), where sync is set up and its stops are answered;
 * a project that asks this device opens it there once, on its own.
 */
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@notefig/ui/utils";
import { useWorkspaceModule } from "@notefig/core/react";
import { useSyncState } from "@/modules/sync/react";
import { lookOf, statusOf } from "./sync-look";

export function SyncStatusCell({ workspacePath, onOpen }: { workspacePath: string | null; onOpen: () => void }) {
  const { t } = useTranslation();
  const state = useSyncState(workspacePath);
  const sync = useWorkspaceModule(workspacePath, "sync");
  const asking = state.setup === "ask";
  // A project that syncs asks this device once, when it opens.
  useEffect(() => {
    if (asking) onOpen();
  }, [asking, onOpen]);
  // A folder that isn't a repo, or the web: nothing to show.
  if (!sync || (state.setup === "unavailable" && !state.reason)) return null;
  const look = lookOf(state);
  const Icon = look.icon;
  return (
    <button
      type="button"
      data-testid="sync-status"
      data-sync-status={statusOf(state)}
      className={cn("flex items-center gap-1.5 hover:text-foreground", state.setup === "off" && "opacity-60")}
      onClick={onOpen}
    >
      <Icon className={cn("h-3.5 w-3.5", look.tone, look.spin && "animate-spin")} />
      <span>{t(look.label)}</span>
    </button>
  );
}
