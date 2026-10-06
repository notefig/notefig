/**
 * The app half of the prompt widget's minimap seam (MET-172): live rows
 * for one bound round, subscription-based rather than hook-based, because
 * the consumer is a ProseMirror plugin view constructed outside React.
 * Reads the same collections `useRound` queries — the minimap can never
 * disagree with the widget face.
 */
import { eq } from "@tanstack/react-db";
import type {
  PromptRoundObserverFactory,
  PromptRoundSnapshot,
} from "@notefig/widgets";
import { defineModule } from "@notefig/core";
import { registerPromptRoundObserver } from "@notefig/widgets";
import type { AgentStore } from "./agent-collections";
import { agentStoreModule } from "./agent-collections";

export const roundObserverFor =
  (store: AgentStore): PromptRoundObserverFactory =>
  ({ turnId, taskId }, onChange) => {
    // Sentinel ids keep the subscriptions unconditional, matching nothing —
    // the same idiom as useRound.
    const turnKey = turnId ?? " none";
    const taskKey = taskId ?? " none";
    const subscriptions = [
      store.turns.subscribeChanges(onChange, {
        where: (row) => eq(row.taskId, taskKey),
      }),
      store.tasks.subscribeChanges(onChange, {
        where: (row) => eq(row.taskId, taskKey),
      }),
      store.permissionRequests.subscribeChanges(onChange, {
        where: (row) => eq(row.taskId, taskKey),
      }),
      store.entries.subscribeChanges(onChange, {
        where: (row) => eq(row.turnId, turnKey),
      }),
    ];
    return {
      get(): PromptRoundSnapshot {
        const taskTurns = store.turns.toArray.filter(
          (turn) => turn.taskId === taskKey,
        );
        return {
          turn: taskTurns.find((turn) => turn.turnId === turnKey),
          task: store.tasks.toArray.find((task) => task.taskId === taskKey),
          taskTurns,
          hasPendingPermission: store.permissionRequests.toArray.some(
            (req) => req.taskId === taskKey && req.status === "pending",
          ),
          entries: store.entries.toArray.filter(
            (entry) => entry.turnId === turnKey,
          ),
        };
      },
      destroy() {
        for (const subscription of subscriptions) subscription.unsubscribe();
      },
    };
  };

/** The minimap's live-rows seam (MET-172), filled from the agent store. */
export const promptRoundObserverModule = defineModule({
  name: "prompt-round-observer",
  needs: [agentStoreModule],
  boot: (_api, ctx) =>
    registerPromptRoundObserver(roundObserverFor(ctx.use("agentStore"))),
});
