/**
 * The focused workspace's sync state in the status bar. Renders nothing for
 * a regular workspace, so the bar is unchanged there. Clicking it opens the
 * Sync settings.
 */
import {
  AlertTriangle,
  CloudOff,
  GitBranch,
  KeyRound,
  Loader2,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@notefig/ui/utils";
import { useSearchParamValue } from "@/hooks/use-search-param-flag";
import { useSyncCapabilities } from "@/modules/sync/react";
import type { SyncStatusKind } from "@/modules/sync";

const LOOK: Record<
  Exclude<SyncStatusKind, "off">,
  { icon: LucideIcon; label: string; tone: string; spin?: boolean }
> = {
  synced: { icon: GitBranch, label: "Synced", tone: "text-success" },
  committing: { icon: Loader2, label: "Committing", tone: "", spin: true },
  pulling: { icon: Loader2, label: "Pulling", tone: "", spin: true },
  pushing: { icon: Loader2, label: "Pushing", tone: "", spin: true },
  offline: { icon: CloudOff, label: "Offline", tone: "text-warning" },
  throttled: { icon: CloudOff, label: "Rate limited", tone: "text-warning" },
  "auth-error": { icon: KeyRound, label: "Sign-in needed", tone: "text-destructive" },
  diverged: { icon: AlertTriangle, label: "Sync stopped", tone: "text-destructive" },
};

export function SyncStatusCell({ workspacePath }: { workspacePath: string | null }) {
  const capabilities = useSyncCapabilities(workspacePath);
  const { setValue: openSettings } = useSearchParamValue("settings");
  if (capabilities.status === "off") return null;
  const look = LOOK[capabilities.status];
  const Icon = look.icon;
  return (
    <button
      type="button"
      data-testid="sync-status"
      data-sync-status={capabilities.status}
      title={capabilities.detail ?? `Sync: ${look.label}`}
      onClick={() => openSettings("sync")}
      className="flex items-center gap-1.5 hover:text-foreground"
    >
      <Icon className={cn("w-3.5 h-3.5", look.tone, look.spin && "animate-spin")} />
      <span>{look.label}</span>
    </button>
  );
}
