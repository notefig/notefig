/**
 * Seen — when the user last had each target in front of them.
 *
 * Attention (`utils/attention.ts`) is a comparison, not a ledger: a
 * thing needs attention when it settled after the user last looked at where
 * it lives. That leaves this module one fact to keep — "last looked", one
 * persisted timestamp per target — and one global listener to keep it: a
 * tab coming to the front (of a focused window) marks its target seen, and a
 * turn that settles on the target already in front is seen the moment it
 * lands. Nothing is stored per item, so nothing per item can be missed.
 *
 * A target is where a turn's result shows up: the chat tab for a session's
 * own turns, the document for a prompt widget's rounds.
 */
import { createCollection } from "@tanstack/react-db";
import {
  persistedCollectionOptions,
  type PersistedCollectionPersistence,
} from "@tanstack/db-sqlite-persistence-core";
import type { PromptRoundsCollection } from "@/modules/prompt-rounds";
import { agentTaskIdFromTabId, isFileTabId } from "@/modules/tabs";
import { defineModule, type CoreHookMap, type Hooks } from "@notefig/core";
import { promptRoundsModule } from "@/modules/prompt-rounds";

export const SEEN_COLLECTION_ID = "seen";

export type SeenTarget =
  { kind: "task"; id: string } | { kind: "document"; id: string };

export interface SeenRow {
  /** `seenKey(target)` */
  id: string;
  lastSeenAt: number;
}

export function seenKey(target: SeenTarget): string {
  return `${target.kind}:${target.id}`;
}

/** What a tab is, as a target: the task for a chat tab, the document for a
 *  file tab, nothing for the rest. */
export function targetOfTab(tabId: string | null): SeenTarget | null {
  if (tabId === null) return null;
  const taskId = agentTaskIdFromTabId(tabId);
  if (taskId !== null) return { kind: "task", id: taskId };
  return isFileTabId(tabId) ? { kind: "document", id: tabId } : null;
}

/** `core.seen`: the ledger and what keeps it. */
export interface SeenApi {
  readonly collection: ReturnType<typeof createSeenCollection>;
  /** Where a settled turn shows up: its widget's document when it was a
   *  widget round, else the session's chat tab. */
  targetOfSettledTurn(
    detail: Pick<CoreHookMap["agent:turn-settled"], "taskId" | "turnId">,
  ): SeenTarget;
  markSeen(target: SeenTarget, at?: number): Promise<void>;
  /** The tab in front. Its target is seen now — if the window is focused;
   *  otherwise when the user comes back to it. */
  setActiveTab(tabId: string | null): void;
  /** The listener's body: a turn settling on the target in front has been
   *  seen — it landed under the user's eyes. Seen at the turn's own settle
   *  time, the value its rows store, so the comparison cannot be split by
   *  two clocks. A backgrounded window has nothing in front, so a turn
   *  settling there needs attention. */
  recordSettledTurn(detail: CoreHookMap["agent:turn-settled"]): Promise<void>;
  /** Boot: the one global listener, plus the window's focus. Returns the
   *  unsubscribe. */
  track(): () => void;
}

function createSeenCollection(persistence: PersistedCollectionPersistence) {
  return createCollection(
    persistedCollectionOptions<SeenRow, string>({
      id: SEEN_COLLECTION_ID,
      getKey: (row) => row.id,
      persistence,
    }),
  );
}

export function createSeen({
  persistence,
  rounds,
  hooks,
}: {
  persistence: PersistedCollectionPersistence;
  rounds: Pick<PromptRoundsCollection, "get">;
  /** Where settled turns are announced. */
  hooks: Pick<Hooks, "on">;
}): SeenApi {
  const seen = createSeenCollection(persistence);

  // In front means under the user's eyes: the active tab of a focused
  // window. Both halves are updated synchronously by the events that change
  // them — a blur flips `windowFocused` before any turn that settles after
  // it can be read against it (no React render in between).
  let activeTarget: SeenTarget | null = null;
  let windowFocused = true;

  const inFrontKey = () =>
    windowFocused && activeTarget ? seenKey(activeTarget) : null;

  const api: SeenApi = {
    collection: seen,
    targetOfSettledTurn(detail) {
      const round = rounds.get(detail.turnId);
      return round
        ? { kind: "document", id: round.documentPath }
        : { kind: "task", id: detail.taskId };
    },
    async markSeen(target, at = Date.now()) {
      await seen.preload();
      const id = seenKey(target);
      const write = seen.get(id)
        ? seen.update(id, (draft) => {
            draft.lastSeenAt = Math.max(draft.lastSeenAt, at);
          })
        : seen.insert({ id, lastSeenAt: at });
      await write.isPersisted.promise;
    },
    setActiveTab(tabId) {
      activeTarget = targetOfTab(tabId);
      if (windowFocused && activeTarget) void api.markSeen(activeTarget);
    },
    async recordSettledTurn(detail) {
      const target = api.targetOfSettledTurn(detail);
      if (seenKey(target) === inFrontKey()) {
        await api.markSeen(target, detail.at);
      }
    },
    track() {
      const onFocus = () => {
        windowFocused = true;
        // Coming back is looking again: the tab in front is seen now.
        if (activeTarget) void api.markSeen(activeTarget);
      };
      const onBlur = () => {
        windowFocused = false;
      };
      window.addEventListener("focus", onFocus);
      window.addEventListener("blur", onBlur);
      const stopSettled = hooks.on("agent:turn-settled", (detail) => {
        void api.recordSettledTurn(detail).catch((error) => {
          console.error("Failed to mark a settled turn seen:", error);
        });
      });
      return () => {
        window.removeEventListener("focus", onFocus);
        window.removeEventListener("blur", onBlur);
        windowFocused = true;
        stopSettled();
      };
    },
  };
  return api;
}

export function lastSeenAt(
  seen: ReadonlyMap<string, number>,
  target: SeenTarget,
): number {
  return seen.get(seenKey(target)) ?? 0;
}

declare module "@notefig/core" {
  interface CoreModules {
    seen: SeenApi;
  }
}

/** Window focus and settled turns feed the seen ledger. */
export const seenModule = defineModule({
  name: "seen",
  needs: ["platform", promptRoundsModule],
  register: (ctx) =>
    createSeen({
      persistence: ctx.use("platform").db.get(),
      rounds: ctx.use("promptRounds").collection,
      hooks: ctx.hooks,
    }),
  boot: (seen) => seen.track(),
});
