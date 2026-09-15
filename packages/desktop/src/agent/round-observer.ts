/**
 * The app half of the prompt widget's minimap seam (MET-172): live rows
 * for one bound round, subscription-based rather than hook-based, because
 * the consumer is a ProseMirror plugin view constructed outside React.
 * Reads the same collections `useRound` queries — the minimap can never
 * disagree with the widget face.
 */
import { eq } from "@tanstack/db";
import type {
  PromptRoundObserverFactory,
  PromptRoundSnapshot,
} from "@notefig/widgets";
import {
  agentEntriesCollection,
  agentPermissionRequestsCollection,
  agentTasksCollection,
  agentTurnsCollection,
} from "./agent-collections";

export const observePromptRound: PromptRoundObserverFactory = (
  { turnId, taskId },
  onChange,
) => {
  // Sentinel ids keep the subscriptions unconditional, matching nothing —
  // the same idiom as useRound.
  const turnKey = turnId ?? " none";
  const taskKey = taskId ?? " none";
  const subscriptions = [
    agentTurnsCollection.subscribeChanges(onChange, {
      where: (row) => eq(row.taskId, taskKey),
    }),
    agentTasksCollection.subscribeChanges(onChange, {
      where: (row) => eq(row.taskId, taskKey),
    }),
    agentPermissionRequestsCollection.subscribeChanges(onChange, {
      where: (row) => eq(row.taskId, taskKey),
    }),
    agentEntriesCollection.subscribeChanges(onChange, {
      where: (row) => eq(row.turnId, turnKey),
    }),
  ];
  return {
    get(): PromptRoundSnapshot {
      const taskTurns = agentTurnsCollection.toArray.filter(
        (turn) => turn.taskId === taskKey,
      );
      return {
        turn: taskTurns.find((turn) => turn.turnId === turnKey),
        task: agentTasksCollection.toArray.find(
          (task) => task.taskId === taskKey,
        ),
        taskTurns,
        hasPendingPermission: agentPermissionRequestsCollection.toArray.some(
          (req) => req.taskId === taskKey && req.status === "pending",
        ),
        entries: agentEntriesCollection.toArray.filter(
          (entry) => entry.turnId === turnKey,
        ),
      };
    },
    destroy() {
      for (const subscription of subscriptions) subscription.unsubscribe();
    },
  };
};
