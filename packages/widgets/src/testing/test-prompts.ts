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

  const prompts = createPromptWidgets({ observeRound });

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
