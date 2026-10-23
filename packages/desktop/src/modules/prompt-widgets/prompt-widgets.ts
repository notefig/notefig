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
 * What outlives a run is the widget's recorded rounds (`core.promptRounds`,
 * MET-251): the service announces each round it starts
 * (`widget:round-started`), and reads each widget's newest record back, so
 * a widget comes back as it was left and its settled face survives a
 * session revival.
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
  type RoundStart,
} from "@notefig/widgets";
import { defineModule } from "@notefig/core";
import type { AgentStore } from "@/modules/agents/agent-collections";
import { agentStoreModule } from "@/modules/agents/agent-collections";
import { promptRoundsModule } from "@/modules/prompt-rounds";

declare module "@notefig/core" {
  interface CoreModules {
    promptWidgets: PromptWidgetsApi;
  }
  interface CoreHookMap {
    /** A prompt widget sent a prompt: a round began in a document. */
    "widget:round-started": RoundStart;
  }
}

/**
 * One bound round's live rows, subscription-based. Only the bound task's
 * rows are watched, and read by key or by the store's task index; the
 * snapshot is kept until one of them changes.
 */
export const roundObserverFor =
  (store: AgentStore): PromptRoundObserverFactory =>
  ({ turnId, taskId }, onChange) => {
    // Sentinel ids keep the subscriptions unconditional, matching nothing —
    // the same idiom as useRound.
    const taskKey = taskId ?? " none";
    let snapshot: PromptRoundSnapshot | null = null;
    const changed = () => {
      snapshot = null;
      onChange();
    };
    const subscriptions = [
      store.turns.subscribeChanges(changed, {
        where: (row) => eq(row.taskId, taskKey),
      }),
      store.tasks.subscribeChanges(changed, {
        where: (row) => eq(row.taskId, taskKey),
      }),
      store.permissionRequests.subscribeChanges(changed, {
        where: (row) => eq(row.taskId, taskKey),
      }),
    ];
    const read = (): PromptRoundSnapshot => {
      let hasPendingPermission = false;
      for (const request of store.permissionRequests.values()) {
        if (request.taskId === taskKey && request.status === "pending") {
          hasPendingPermission = true;
          break;
        }
      }
      return {
        turn: turnId ? store.turns.get(turnId) : undefined,
        task: store.tasks.get(taskKey),
        taskTurns: store.turnsForTask(taskKey),
        hasPendingPermission,
      };
    };
    return {
      get: () => (snapshot ??= read()),
      destroy() {
        for (const subscription of subscriptions) subscription.unsubscribe();
      },
    };
  };

export const promptWidgetsModule = defineModule({
  name: "promptWidgets",
  needs: [agentStoreModule, promptRoundsModule],
  register: (ctx) => {
    const rounds = ctx.use("promptRounds");
    return createPromptWidgets({
      observeRound: roundObserverFor(ctx.use("agentStore")),
      observeStoredRound: rounds.observeNewest,
      announceRound: (round) => ctx.hooks.emit("widget:round-started", round),
      reviewRanges: rounds.reviewRanges,
    });
  },
});
