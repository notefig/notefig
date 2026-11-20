/**
 * Who else syncs the branch now, as small overlapping dots in the colours
 * of their carets, centred on the line beside them; `PeersTooltip` names
 * them when what it wraps is hovered. Leaves, for the status bar and the
 * Remote tool.
 */
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Tooltip, TooltipContent, TooltipTrigger } from "@notefig/ui/tooltip";
import type { SyncPeer } from "@/modules/sync";

function Dot({ peer }: { peer: SyncPeer }) {
  return (
    <span
      className="size-2 shrink-0 rounded-full bg-muted-foreground ring-1 ring-background"
      style={peer.colour ? { backgroundColor: peer.colour } : undefined}
    />
  );
}

export function PeerDots({ peers }: { peers: SyncPeer[] }) {
  if (peers.length === 0) return null;
  return (
    <span
      data-sync-peer-dots=""
      className="flex shrink-0 items-center self-center -space-x-0.5"
    >
      {peers.map((peer) => (
        <Dot key={peer.deviceId} peer={peer} />
      ))}
    </span>
  );
}

/** Each peer by name, beside their colour. */
function PeerNames({ peers }: { peers: SyncPeer[] }) {
  const { t } = useTranslation();
  return (
    <span data-sync-peer-names="" className="flex flex-col gap-0.5">
      {peers.map((peer) => (
        <span key={peer.deviceId} className="flex items-center gap-1.5">
          <Dot peer={peer} />
          {peer.name ?? t("syncUnnamedPeer")}
        </span>
      ))}
    </span>
  );
}

/** `children` names the peers the moment it's hovered, and stops as soon
 *  as the pointer leaves: a whole cell, as the dots alone are too small a
 *  target. With nobody else here, just `children`. */
export function PeersTooltip({
  peers,
  children,
}: {
  peers: SyncPeer[];
  children: ReactElement;
}) {
  if (peers.length === 0) return children;
  return (
    <Tooltip delayDuration={0} disableHoverableContent>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="top" className="px-2 py-1 text-xs duration-100">
        <PeerNames peers={peers} />
      </TooltipContent>
    </Tooltip>
  );
}
