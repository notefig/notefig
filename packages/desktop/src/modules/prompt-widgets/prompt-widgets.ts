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
 * What outlives a run is the widget's stored rounds (`core.promptRounds`,
 * MET-251): the service reads each widget's newest one, so a widget comes
 * back as it was left and its settled face survives a session revival.
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
  type PromptWidgetsDeps,
} from "@notefig/widgets";
import { defineModule } from "@notefig/core";
import type { AgentStore } from "@/modules/agents/agent-collections";
import { agentStoreModule } from "@/modules/agents/agent-collections";
import {
  promptRoundsModule,
  type PromptRoundRow,
  type PromptRoundsCollection,
} from "@/modules/prompt-rounds";

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

/** A widget's newest stored round, subscription-based. */
export const storedRoundObserverFor =
  (
    rounds: PromptRoundsCollection,
  ): NonNullable<PromptWidgetsDeps["observeStoredRound"]> =>
  (blobId, onChange) => {
    const subscription = rounds.subscribeChanges(onChange, {
      where: (row) => eq(row.blobId, blobId),
    });
    return {
      get() {
        let newest: PromptRoundRow | undefined;
        for (const row of rounds.values()) {
          if (row.blobId !== blobId) continue;
          if (!newest || row.startedAt > newest.startedAt) newest = row;
        }
        return newest
          ? {
              turnId: newest.turnId,
              taskId: newest.taskId,
              status: newest.status,
              prompt: newest.fullPrompt ?? newest.prompt,
              outcome: newest.outcome ?? null,
            }
          : undefined;
      },
      destroy: () => subscription.unsubscribe(),
    };
  };

export const promptWidgetsModule = defineModule({
  name: "promptWidgets",
  needs: [agentStoreModule, promptRoundsModule],
  register: (ctx) =>
    createPromptWidgets({
      observeRound: roundObserverFor(ctx.use("agentStore")),
      observeStoredRound: storedRoundObserverFor(
        ctx.use("promptRounds").collection,
      ),
      reviewRanges: ctx.use("promptRounds").reviewRanges,
    }),
});
