/**
 * The shared per-workspace session all prompt blobs queue into. Lazily
 * started on the first blob send (default harness) and reused across every
 * widget — the agent-service task already FIFO-queues turns, so concurrent
 * widgets just line up. The rotate control replaces the shared session with
 * a fresh one; the old task is never cancelled here (it stays alive and
 * visible in the sessions panel, and any widget bound to one of its turns
 * keeps watching it).
 */
import type { HarnessDefinition } from "@metrists/shared/agent";
import { normalizePath } from "@/utils/fs";
import { agentTasksCollection } from "@/agent/agent-collections";
import { startAgentTask } from "@/agent/agent-service";

type SharedSession = { taskId: string; started: Promise<void> };

const sessions = new Map<string, SharedSession>();

/** A cached session is only reusable while its task row is still live.
 *  "restored" counts as live — prompting it revives via session/load. */
function isReusable(session: SharedSession): boolean {
  const row = agentTasksCollection.get(session.taskId);
  return (
    row !== undefined &&
    row.status !== "error" &&
    row.status !== "cancelled" &&
    row.status !== "unavailable"
  );
}

/**
 * The session blob prompts should target, starting one if needed. Resolves
 * once the session is ready to prompt (prompting before the ACP handshake
 * completes would settle the turn as an error).
 */
export async function getOrStartSharedSession(
  workspacePath: string,
  harness: HarnessDefinition,
): Promise<{ taskId: string }> {
  const key = normalizePath(workspacePath);
  let session = sessions.get(key);
  if (!session || !isReusable(session)) {
    const { taskId, started } = startAgentTask(workspacePath, harness);
    session = { taskId, started };
    sessions.set(key, session);
  }
  await session.started;
  return { taskId: session.taskId };
}

/**
 * Forget the shared session (the "new session" control): the next send
 * lazily starts a fresh one. Deliberately no eager spawn — rotating without
 * ever sending shouldn't leave an idle process behind. The old task is not
 * cancelled; it stays in the sessions panel.
 */
export function dropSharedSession(workspacePath: string): void {
  sessions.delete(normalizePath(workspacePath));
}

/** Point the shared session at an existing live task (the session-picker
 *  path). No-op if the task row is missing or terminal. */
export function adoptSharedSession(workspacePath: string, taskId: string): void {
  const row = agentTasksCollection.get(taskId);
  if (
    !row ||
    row.status === "error" ||
    row.status === "cancelled" ||
    row.status === "unavailable"
  ) {
    return;
  }
  sessions.set(normalizePath(workspacePath), {
    taskId,
    started: Promise.resolve(),
  });
}

/** Current shared session's taskId, if one is live — for rendering only. */
export function peekSharedSession(workspacePath: string): string | null {
  const session = sessions.get(normalizePath(workspacePath));
  return session && isReusable(session) ? session.taskId : null;
}

/** Test-only: reset module state between cases. */
export function resetSharedSessionsForTest(): void {
  sessions.clear();
}
