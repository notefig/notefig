/**
 * Prompt rounds from React.
 */
import { useMemo } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { useOpenWorkspaces } from "@/modules/workspaces/react";
import { derivePromptRounds, type PromptRound } from "./prompt-rounds";
import { useCore } from "@notefig/core/react";

/**
 * The prompt rounds across every open workspace: live ones first, then the
 * most recent, capped at `limit`.
 */
export function usePromptRounds(limit: number): PromptRound[] {
  const { promptRounds, agentStore: store } = useCore();
  const rounds = promptRounds.collection;
  const { data: rows = [] } = useLiveQuery((q) => q.from({ round: rounds }));
  const { data: turns = [] } = useLiveQuery((q) =>
    q.from({ turn: store.turns }),
  );
  const openWorkspaces = useOpenWorkspaces();
  return useMemo(
    () => derivePromptRounds(rows, openWorkspaces, turns).slice(0, limit),
    [rows, openWorkspaces, turns, limit],
  );
}
