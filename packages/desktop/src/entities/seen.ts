/**
 * Seen — when the user last had each target in front of them.
 *
 * Attention (`entities/attention.ts`) is a comparison, not a ledger: a
 * thing needs attention when it settled after the user last looked at where
 * it lives. That leaves this module one fact to keep — "last looked", one
 * persisted timestamp per target — and one global listener to keep it: a
 * tab coming to the front marks its target seen, and a turn that settles on
 * the target already in front is seen the moment it lands. Nothing is
 * stored per item, so nothing per item can be missed.
 *
 * A target is where a turn's result shows up: the chat tab for a session's
 * own turns, the document for a prompt widget's rounds.
 */
import { useEffect } from "react";
import { createCollection, useLiveQuery } from "@tanstack/react-db";
import { persistedCollectionOptions } from "@tanstack/db-sqlite-persistence-core";
import { platformAdapter } from "@/adapters";
import { promptRoundsCollection } from "@/entities/prompt-rounds";
import { agentTaskIdFromTabId, isFileTabId } from "@/entities/tabs";
import { onAppEvent, type AppEvents } from "@/utils/app-events";

export const SEEN_COLLECTION_ID = "seen";

export type SeenTarget =
  | { kind: "task"; id: string }
  | { kind: "document"; id: string };

export interface SeenRow {
  /** `seenKey(target)` */
  id: string;
  lastSeenAt: number;
}

export function seenKey(target: SeenTarget): string {
  return `${target.kind}:${target.id}`;
}

export const seenCollection = createCollection(
  persistedCollectionOptions<SeenRow, string>({
    id: SEEN_COLLECTION_ID,
    getKey: (row) => row.id,
    persistence: platformAdapter.db.get(),
  }),
);

/** What a tab is, as a target: the task for a chat tab, the document for a
 *  file tab, nothing for the rest. */
export function targetOfTab(tabId: string | null): SeenTarget | null {
  if (tabId === null) return null;
  const taskId = agentTaskIdFromTabId(tabId);
  if (taskId !== null) return { kind: "task", id: taskId };
  return isFileTabId(tabId) ? { kind: "document", id: tabId } : null;
}

/** Where a settled turn shows up: its widget's document when it was a
 *  widget round, else the session's chat tab. */
export function targetOfSettledTurn(
  detail: Pick<AppEvents["agent:turn-settled"], "taskId" | "turnId">,
): SeenTarget {
  const round = promptRoundsCollection.get(detail.turnId);
  return round
    ? { kind: "document", id: round.documentPath }
    : { kind: "task", id: detail.taskId };
}

export async function markSeen(
  target: SeenTarget,
  at: number = Date.now(),
): Promise<void> {
  await seenCollection.preload();
  const id = seenKey(target);
  const write = seenCollection.get(id)
    ? seenCollection.update(id, (draft) => {
        draft.lastSeenAt = Math.max(draft.lastSeenAt, at);
      })
    : seenCollection.insert({ id, lastSeenAt: at });
  await write.isPersisted.promise;
}

let activeKey: string | null = null;

/** Tests / the shell: the tab in front. Its target is seen now. */
export function setActiveTabForSeen(tabId: string | null): void {
  const target = targetOfTab(tabId);
  activeKey = target && seenKey(target);
  if (target) void markSeen(target);
}

/** Mount once, in the shell: keeps the tracker told which tab is in front. */
export function useTrackActiveTab(activeTabId: string | null): void {
  useEffect(() => {
    setActiveTabForSeen(activeTabId);
  }, [activeTabId]);
}

/** The listener's body, exported for tests: a turn settling on the target
 *  in front has been seen — it landed under the user's eyes. */
export async function recordSettledTurn(
  detail: AppEvents["agent:turn-settled"],
  now: number = Date.now(),
): Promise<void> {
  const target = targetOfSettledTurn(detail);
  if (seenKey(target) === activeKey) await markSeen(target, now);
}

/** Boot: the one global listener. Returns the unsubscribe. */
export function startSeenTracking(): () => void {
  return onAppEvent("agent:turn-settled", (detail) => {
    void recordSettledTurn(detail).catch((error) => {
      console.error("Failed to mark a settled turn seen:", error);
    });
  });
}

/** `seenKey` → lastSeenAt, live. */
export function useSeen(): ReadonlyMap<string, number> {
  const { data = [] } = useLiveQuery((q) => q.from({ seen: seenCollection }));
  return new Map(data.map((row) => [row.id, row.lastSeenAt]));
}

export function lastSeenAt(
  seen: ReadonlyMap<string, number>,
  target: SeenTarget,
): number {
  return seen.get(seenKey(target)) ?? 0;
}
