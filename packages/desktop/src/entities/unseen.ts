/**
 * Unseen — the settled agent turns the user has not looked at yet, for the
 * Everything view and the sessions panel.
 *
 * One global listener does all the bookkeeping: on the app's
 * `agent:turn-settled` event it writes a row per *target* the turn belongs
 * to — the task (its chat tab) and, for a widget round, the document the
 * widget lives in — unless that target is the tab in front right now. A
 * tab becoming active clears its target's rows. The rows are persisted, so
 * what settled while the app was closed is still marked after a relaunch.
 * Nothing on the turn or task rows changes for this.
 */
import { useEffect, useMemo } from "react";
import { createCollection, useLiveQuery } from "@tanstack/react-db";
import { persistedCollectionOptions } from "@tanstack/db-sqlite-persistence-core";
import { findPromptBlobForTask } from "@notefig/widgets";
import { platformAdapter } from "@/adapters";
import { agentTaskIdFromTabId, isFileTabId } from "@/entities/tabs";
import { onAppEvent, type AppEvents } from "@/utils/app-events";

export const UNSEEN_COLLECTION_ID = "unseen";

export interface UnseenRow {
  /** `${target}:${turnId}` */
  id: string;
  /** A task id (chat tab) or an absolute document path (its widgets). */
  target: string;
  turnId: string;
  at: number;
}

export const unseenCollection = createCollection(
  persistedCollectionOptions<UnseenRow, string>({
    id: UNSEEN_COLLECTION_ID,
    getKey: (row) => row.id,
    persistence: platformAdapter.db.get(),
  }),
);

/** What a tab id is, as a target: the task for a chat tab, the path for a
 *  file tab, nothing for the rest. */
export function targetOfTab(tabId: string | null): string | null {
  if (tabId === null) return null;
  const taskId = agentTaskIdFromTabId(tabId);
  if (taskId !== null) return taskId;
  return isFileTabId(tabId) ? tabId : null;
}

/** The targets a settled turn lands on: its task, and its widget's document. */
export function targetsOfSettledTurn(
  detail: Pick<AppEvents["agent:turn-settled"], "taskId" | "turnId">,
): string[] {
  const widget = findPromptBlobForTask(detail.taskId, detail.turnId);
  return widget && widget.boundTurnId === detail.turnId
    ? [detail.taskId, widget.documentPath]
    : [detail.taskId];
}

let activeTarget: string | null = null;

async function clearTarget(target: string): Promise<void> {
  await unseenCollection.preload();
  const ids = [...unseenCollection.values()]
    .filter((row) => row.target === target)
    .map((row) => row.id);
  if (ids.length > 0) await unseenCollection.delete(ids).isPersisted.promise;
}

/** The listener's body, exported for tests: mark every target of the
 *  settled turn that is not in front. */
export async function recordSettledTurn(
  detail: AppEvents["agent:turn-settled"],
  now: number = Date.now(),
): Promise<void> {
  await unseenCollection.preload();
  for (const target of targetsOfSettledTurn(detail)) {
    if (target === activeTarget) continue;
    const id = `${target}:${detail.turnId}`;
    if (unseenCollection.get(id)) continue;
    await unseenCollection.insert({ id, target, turnId: detail.turnId, at: now })
      .isPersisted.promise;
  }
}

/** Boot: the one global listener. Returns the unsubscribe. */
export function startUnseenTracking(): () => void {
  return onAppEvent("agent:turn-settled", (detail) => {
    void recordSettledTurn(detail).catch((error) => {
      console.error("Failed to record an unseen turn:", error);
    });
  });
}

/** Tests / the shell: the tab in front. Clears its target's rows. */
export function setActiveTabForUnseen(tabId: string | null): void {
  activeTarget = targetOfTab(tabId);
  if (activeTarget !== null) void clearTarget(activeTarget);
}

/** Mount once, in the shell: keeps the tracker told which tab is in front. */
export function useTrackActiveTab(activeTabId: string | null): void {
  useEffect(() => {
    setActiveTabForUnseen(activeTabId);
  }, [activeTabId]);
}

export function useUnseenRows(): UnseenRow[] {
  const { data = [] } = useLiveQuery((q) =>
    q.from({ unseen: unseenCollection }),
  );
  return data;
}

/** Targets with anything unseen — the sessions lists' mark. */
export function useUnseenTargets(): Set<string> {
  const rows = useUnseenRows();
  return useMemo(() => new Set(rows.map((row) => row.target)), [rows]);
}

export function isTurnUnseen(
  rows: UnseenRow[],
  target: string,
  turnId: string,
): boolean {
  return rows.some((row) => row.target === target && row.turnId === turnId);
}
