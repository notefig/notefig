/**
 * A prompt service over in-memory agent rows, for tests that drive a widget
 * through its states: publish a turn, a sign-in hold or a pending
 * permission, and every widget watching it reconciles exactly as it would
 * against the app's collections.
 */
import { vi } from "vitest";
import type { AgentTaskRow, AgentTurn } from "@notefig/shared/agent";
import {
  createPromptWidgets,
  type PromptRoundObserverFactory,
  type PromptWidgetsDeps,
  type StoredRound,
} from "../prompt/widgets-service";

export function testPrompts() {
  const turns = new Map<string, AgentTurn>();
  const tasks = new Map<string, Partial<AgentTaskRow>>();
  const pending = new Set<string>();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  const observeRound: PromptRoundObserverFactory = (
    { turnId, taskId },
    onChange,
  ) => {
    listeners.add(onChange);
    return {
      get: () => ({
        turn: turnId ? turns.get(turnId) : undefined,
        task: taskId ? (tasks.get(taskId) as AgentTaskRow | undefined) : undefined,
        taskTurns: [...turns.values()].filter((turn) => turn.taskId === taskId),
        hasPendingPermission: taskId ? pending.has(taskId) : false,
        entries: [],
      }),
      destroy: () => {
        listeners.delete(onChange);
      },
    };
  };

  /** The app's stored rounds, newest per widget. */
  const stored = new Map<string, StoredRound>();
  const storedListeners = new Set<() => void>();
  const observeStoredRound: NonNullable<PromptWidgetsDeps["observeStoredRound"]> = (
    blobId,
    onChange,
  ) => {
    storedListeners.add(onChange);
    return {
      get: () => stored.get(blobId),
      destroy: () => {
        storedListeners.delete(onChange);
      },
    };
  };

  const prompts = createPromptWidgets({ observeRound, observeStoredRound });

  return {
    prompts,
    /** Stop commands that record their calls. */
    commands: { cancelTask: vi.fn(), removeQueuedPrompt: vi.fn() },
    /** Write (or overwrite) a turn row. */
    setTurn(
      turnId: string,
      taskId: string,
      status: AgentTurn["status"],
    ): void {
      turns.set(turnId, {
        turnId,
        taskId,
        sessionId: "",
        status,
        startedAt: 0,
      });
      notify();
    },
    /** Store (or overwrite) a widget's newest round, as the app does. */
    storeRound(blobId: string, round: StoredRound): void {
      stored.set(blobId, round);
      for (const listener of [...storedListeners]) listener();
    },
    /** Drop a turn row (a withdrawn or forgotten turn). */
    removeTurn(turnId: string): void {
      turns.delete(turnId);
      notify();
    },
    setAuthRequired(taskId: string, authRequired: boolean): void {
      tasks.set(taskId, { ...tasks.get(taskId), taskId, authRequired });
      notify();
    },
    setPendingPermission(taskId: string, isPending: boolean): void {
      if (isPending) pending.add(taskId);
      else pending.delete(taskId);
      notify();
    },
    /** Send `prompt` from `blobId`, the dispatch writing a queued turn. */
    send(
      blobId: string,
      prompt: string,
      round: { taskId: string; turnId: string },
    ): Promise<boolean> {
      return prompts.send(blobId, prompt, async () => {
        turns.set(round.turnId, {
          turnId: round.turnId,
          taskId: round.taskId,
          sessionId: "",
          status: "queued",
          startedAt: 0,
        });
        return round;
      });
    },
  };
}

export type TestPrompts = ReturnType<typeof testPrompts>;
