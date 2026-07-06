/**
 * Per-task process supervision for the thin worker. The worker's entire
 * job description: spawn one adapter process per taskId on ctl start-task,
 * pump its stdio lines to/from "acp" frames tagged with that taskId, kill
 * on stop-task, and report exits as ctl task-exit events. It never parses
 * a JSON-RPC line — web mode advertises fs:false, so no protocol method is
 * ever answered on this side.
 */
import type { CtlMessage, HarnessDefinition } from '@metrists/shared';

export type SupervisedTask = {
  taskId: string;
  send: (line: string) => void;
  kill: () => Promise<void>;
};

export class TaskSupervisor {
  /**
   * Handle a ctl message from the app (start-task / stop-task / list-tasks).
   */
  async handleCtl(_message: CtlMessage): Promise<void> {
    // TODO(phase 3): start-task → spawnTask; stop-task → kill; list-tasks →
    // reply on ctl channel.
    throw new Error('not implemented: handleCtl');
  }

  /** Spawn one adapter process for a task (child_process, piped stdio). */
  async spawnTask(
    _taskId: string,
    _harness: HarnessDefinition,
    _cwd: string,
  ): Promise<SupervisedTask> {
    // TODO(phase 3): line-buffered stdout → onTaskLine; exit → onTaskExit.
    throw new Error('not implemented: spawnTask');
  }

  /** Incoming acp frame body for a task → that process's stdin. */
  writeTaskLine(_taskId: string, _line: string): void {
    throw new Error('not implemented: writeTaskLine');
  }

  onTaskLine(_callback: (taskId: string, line: string) => void): () => void {
    return () => undefined;
  }

  onTaskExit(
    _callback: (taskId: string, code: number | null) => void,
  ): () => void {
    return () => undefined;
  }

  async killAll(): Promise<void> {
    // TODO(phase 3)
  }
}
