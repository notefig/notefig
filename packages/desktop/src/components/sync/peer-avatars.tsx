/**
 * Who else syncs the branch now, as small overlapping avatars in the
 * colours of their carets. A leaf, for the status bar and the Remote tool.
 */
import { useTranslation } from "react-i18next";
import { Avatar, AvatarFallback } from "@notefig/ui/avatar";
import { cn } from "@notefig/ui/utils";
import type { SyncPeer } from "@/modules/sync";

export function PeerAvatars({ peers }: { peers: SyncPeer[] }) {
  const { t } = useTranslation();
  if (peers.length === 0) return null;
  return (
    <span className="flex shrink-0 -space-x-1">
      {peers.map((peer) => {
        const name = peer.name ?? t("syncUnnamedPeer");
        return (
          <Avatar key={peer.deviceId} data-sync-peer={peer.deviceId} title={name} className="size-3.5 ring-1 ring-background">
            <AvatarFallback
              className={cn("text-[8px] font-medium", peer.colour ? "text-white" : "text-muted-foreground")}
              style={peer.colour ? { backgroundColor: peer.colour } : undefined}
            >
              {name.slice(0, 1).toUpperCase()}
            </AvatarFallback>
          </Avatar>
        );
      })}
    </span>
  );
}
