/**
 * Prompt rounds from React.
 */
import { useMemo } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { useModule } from "@notefig/core/react";
import { useAgentStore } from "@/modules/agents/react";
import { useOpenWorkspaces } from "@/modules/workspaces/react";
import { derivePromptRounds, type PromptRound } from "./prompt-rounds";

/**
 * The prompt rounds across every open workspace: live ones first, then the
 * most recent, capped at `limit`.
 */
export function usePromptRounds(limit: number): PromptRound[] {
  const rounds = useModule("promptRounds").collection;
  const store = useAgentStore();
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
