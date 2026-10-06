/**
 * The seen ledger from React: keep it told which tab is in front, and read it live.
 */
import { useEffect } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { useCore } from "@notefig/core/react";

/** Mount once, in the shell: keeps the tracker told which tab is in front. */
export function useTrackActiveTab(activeTabId: string | null): void {
  const { seen } = useCore();
  useEffect(() => {
    seen.setActiveTab(activeTabId);
  }, [seen, activeTabId]);
}

/** `seenKey` → lastSeenAt, live. */
export function useSeen(): ReadonlyMap<string, number> {
  const { collection } = useCore().seen;
  const { data = [] } = useLiveQuery((q) => q.from({ seen: collection }));
  return new Map(data.map((row) => [row.id, row.lastSeenAt]));
}
