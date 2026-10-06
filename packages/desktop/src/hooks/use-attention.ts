/**
 * Live `deriveAttention` (utils/attention.ts) over the collections: tasks,
 * rounds, running turns, pending permissions, the open set and the seen
 * ledger.
 */
import { useMemo } from "react";
import { useLiveQuery, eq } from "@tanstack/react-db";
import { useModule } from "@notefig/core/react";
import { useAgentStore } from "@/modules/agents/react";
import { useSeen } from "@/modules/seen/react";
import { useOpenWorkspaces } from "@/modules/workspaces/react";
import { deriveAttention, type Attention } from "@/utils/attention";

export function useAttention(): Attention {
  const store = useAgentStore();
  const roundRows = useModule("promptRounds").collection;
  const { data: tasks = [] } = useLiveQuery((q) =>
    q.from({ task: store.tasks }),
  );
  const { data: rounds = [] } = useLiveQuery((q) =>
    q.from({ round: roundRows }),
  );
  const { data: runningTurns = [] } = useLiveQuery((q) =>
    q
      .from({ turn: store.turns })
      .where(({ turn }) => eq(turn.status, "running")),
  );
  const { data: pendingPermissions = [] } = useLiveQuery((q) =>
    q
      .from({ req: store.permissionRequests })
      .where(({ req }) => eq(req.status, "pending")),
  );
  const openWorkspaces = useOpenWorkspaces();
  const seen = useSeen();
  return useMemo(
    () =>
      deriveAttention({
        tasks,
        rounds,
        runningTurns,
        openWorkspaceKeys: new Set(openWorkspaces.map((row) => row.key)),
        pendingPermissions,
        seen,
      }),
    [tasks, rounds, runningTurns, openWorkspaces, pendingPermissions, seen],
  );
}
