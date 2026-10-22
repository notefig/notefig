/**
 * Every prompt widget's state, as a core module: `core.promptWidgets`.
 *
 * The service and its state machine are the widget package's
 * (`createPromptWidgets`); this module builds it over the agent store. Each
 * widget's round is watched through the store's collections — the same
 * rows `useRound` queries, so the state can never disagree with what the
 * card shows. The service only keeps state: sending and stopping are the
 * widget's, through its host.
 *
 * The editor hands the service to its widgets (editor-store.ts); the app
 * reads it for session → widget lookups (jump-to-task, change attribution).
 */
import { eq } from "@tanstack/react-db";
import {
  createPromptWidgets,
  type PromptRoundObserverFactory,
  type PromptRoundSnapshot,
  type PromptWidgetsApi,
} from "@notefig/widgets";
import { defineModule } from "@notefig/core";
import type { AgentStore } from "@/modules/agents/agent-collections";
import { agentStoreModule } from "@/modules/agents/agent-collections";

declare module "@notefig/core" {
  interface CoreModules {
    promptWidgets: PromptWidgetsApi;
  }
}

/** One bound round's live rows, subscription-based. */
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

export const promptWidgetsModule = defineModule({
  name: "promptWidgets",
  needs: [agentStoreModule],
  register: (ctx) =>
    createPromptWidgets({
      observeRound: roundObserverFor(ctx.use("agentStore")),
    }),
});
