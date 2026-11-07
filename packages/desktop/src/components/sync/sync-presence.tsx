/**
 * Who else is here (MET-272): a status-bar cell, shown only at the shared
 * level and only while another device is present. It stacks the people's
 * initials in their colours; its popover lists each person with the
 * document they're in, and their agents under them (harness, what it's
 * doing, where), in the person's colour with an agent marker.
 *
 * Clicking a person (or an agent) opens the document and puts the caret
 * where they are. Each person and each agent shows how many blocks it
 * holds (MET-273's leases, `SyncPeer.holds`), live: a lock count appears,
 * changes and goes as leases are taken and released, in the list and on
 * the status-bar cell. The footer shows what this device holds.
 */
import { Bot, Lock } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@notefig/ui/popover";
import { cn } from "@notefig/ui/utils";
import { useCore } from "@notefig/core/react";
import type { Core } from "@notefig/core";
import { useSearchParamValue } from "@/hooks/use-search-param-flag";
import { useSyncCapabilities, useSyncLeases, useSyncPresence } from "@/modules/sync/react";
import { fromBlockPosition } from "@/modules/sync/presence-position";
import type { SyncBlockPosition, SyncPeer } from "@/modules/sync";
import { path as pathutil } from "@/utils/path";

const MAX_STACK = 3;

/** Open `path` and put the caret at `position` (when known). */
export async function jumpToPresence(
  core: Pick<Core, "tabs" | "editors">,
  path: string,
  position?: SyncBlockPosition,
): Promise<void> {
  if (!core.tabs.open(path, { intent: "replace" })) return;
  await core.editors.whenMounted(path);
  const editor = core.editors.markdownEditor(path);
  if (!editor || !position) return;
  const pos = fromBlockPosition(editor.state.doc, position);
  if (pos === null) return;
  editor.chain().focus().setTextSelection(pos).scrollIntoView().run();
}

const initial = (name: string) => (name.trim()[0] ?? "?").toUpperCase();

function Avatar({
  name,
  color,
  size = "md",
  agent = false,
  className,
}: {
  name: string;
  color: string;
  size?: "sm" | "md";
  agent?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white",
        size === "md" ? "h-5 w-5 text-[10px]" : "h-4 w-4 text-[9px]",
        className,
      )}
      style={{ backgroundColor: color }}
    >
      {agent ? <Bot className="h-2.5 w-2.5" /> : initial(name)}
    </span>
  );
}

const blocks = (count: number) => `${count} ${count === 1 ? "block" : "blocks"}`;

/** How many blocks a holder leases, live; keyed on the count so a lease
 *  taken or released shows as a small fade. */
function Holds({ count, testId }: { count: number | undefined; testId: string }) {
  if (!count) return null;
  return (
    <span
      key={count}
      className="flex shrink-0 items-center gap-0.5 text-[10px] text-muted-foreground animate-in fade-in-0 zoom-in-95 duration-200"
      data-testid={testId}
      title={`Holds ${blocks(count)}: read-only to everyone else while they edit`}
    >
      <Lock aria-hidden className="h-2.5 w-2.5" />
      <span>holds {blocks(count)}</span>
    </span>
  );
}

const docName = (path?: string) => (path ? pathutil.basename(path) : null);

function PeerRow({ peer, onJump }: { peer: SyncPeer; onJump: (path: string, at?: SyncBlockPosition) => void }) {
  const cursor = peer.cursors[0];
  const where = docName(cursor?.path);
  return (
    <li data-testid="sync-presence-peer" data-device={peer.deviceId}>
      <button
        type="button"
        disabled={!cursor}
        onClick={() => cursor && onJump(cursor.path, cursor.head ?? cursor.anchor)}
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-muted disabled:cursor-default disabled:hover:bg-transparent"
        title={cursor ? `Go to ${peer.name}'s cursor` : undefined}
      >
        <Avatar name={peer.name} color={peer.color} className={cn(!peer.focused && "opacity-60")} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium text-foreground">{peer.name}</span>
          <span className="block truncate text-[11px] text-muted-foreground">
            {where ?? "In the workspace"}
            {!peer.focused && " · away"}
          </span>
        </span>
        <Holds count={peer.holds} testId="sync-presence-holds" />
      </button>
      {peer.agents.length > 0 && (
        <ul className="ml-5 border-l border-border pl-2">
          {peer.agents.map((agent) => (
            <li key={agent.taskId} data-testid="sync-presence-agent">
              <button
                type="button"
                disabled={!agent.path}
                onClick={() => agent.path && onJump(agent.path, agent.anchor)}
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-muted disabled:cursor-default disabled:hover:bg-transparent"
                title={agent.label}
              >
                <Avatar name={agent.harness} color={peer.color} size="sm" agent />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[11px] text-foreground">
                    <span className="font-medium">{agent.harness}</span>
                    <span className="text-muted-foreground">
                      {" "}
                      · {agent.status === "editing" ? "editing" : "working"}
                      {docName(agent.path) ? ` ${docName(agent.path)}` : ""}
                    </span>
                  </span>
                  <span className="block truncate text-[10px] text-muted-foreground">{agent.label}</span>
                </span>
                <Holds count={agent.holds} testId="sync-presence-agent-holds" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The status-bar trigger: initials, agents, and the blocks held. */
function PresenceStack({ peers, agents, held }: { peers: readonly SyncPeer[]; agents: number; held: number }) {
  return (
    <>
      <span className="flex -space-x-1.5">
        {peers.slice(0, MAX_STACK).map((peer) => (
          <Avatar key={peer.deviceId} name={peer.name} color={peer.color} size="sm" className="ring-2 ring-secondary" />
        ))}
      </span>
      {peers.length > MAX_STACK && <span>+{peers.length - MAX_STACK}</span>}
      {agents > 0 && (
        <span className="flex items-center gap-0.5">
          <Bot className="h-3 w-3" />
          {agents}
        </span>
      )}
      {held > 0 && (
        <span key={held} className="flex items-center gap-0.5 animate-in fade-in-0 duration-200" data-testid="sync-presence-held">
          <Lock className="h-2.5 w-2.5" />
          {held}
        </span>
      )}
    </>
  );
}

/** "You appear as …", with what this device holds; opens Settings. */
function MeRow({ workspacePath, onOpen }: { workspacePath: string; onOpen: () => void }) {
  const core = useCore();
  const leases = useSyncLeases(workspacePath);
  const workspace = core.workspace(workspacePath);
  const me = workspace.isOpen() ? workspace.sync.identity() : null;
  if (!me) return null;
  const mine = leases.filter((lease) => lease.mine).reduce((sum, lease) => sum + lease.blocks.length, 0);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="mt-1 flex w-full items-center gap-2 border-t border-border px-2 pb-0.5 pt-1.5 text-left text-[11px] text-muted-foreground hover:text-foreground"
    >
      <Avatar name={me.name} color={me.color} size="sm" />
      <span className="min-w-0 flex-1 truncate">You appear as {me.name}</span>
      <Holds count={mine} testId="sync-presence-mine" />
    </button>
  );
}

export function SyncPresenceCell({ workspacePath }: { workspacePath: string | null }) {
  const core = useCore();
  const capabilities = useSyncCapabilities(workspacePath);
  const peers = useSyncPresence(workspacePath);
  const { setValue: openSettings } = useSearchParamValue("settings");
  if (!workspacePath || !capabilities.presence || peers.length === 0) return null;
  const held = peers.reduce((sum, peer) => sum + (peer.holds ?? 0), 0);
  const agents = peers.reduce((sum, peer) => sum + peer.agents.length, 0);
  const label = [
    `${count(peers.length, "person", "people")} here`,
    ...(agents > 0 ? [count(agents, "agent", "agents")] : []),
    ...(held > 0 ? [`${blocks(held)} held`] : []),
  ].join(", ");
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="sync-presence"
          aria-label={label}
          title={label}
          className="flex items-center gap-1.5 hover:text-foreground"
        >
          <PresenceStack peers={peers} agents={agents} held={held} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-1.5">
        <p className="px-2 pb-1 pt-0.5 text-[11px] font-medium text-muted-foreground">
          In this workspace
        </p>
        <ul className="space-y-0.5">
          {peers.map((peer) => (
            <PeerRow
              key={peer.deviceId}
              peer={peer}
              onJump={(path, at) => void jumpToPresence(core, path, at)}
            />
          ))}
        </ul>
        <MeRow workspacePath={workspacePath} onOpen={() => openSettings("sync")} />
      </PopoverContent>
    </Popover>
  );
}
