/**
 * Flat taskId → AgentTask registry (editor-store convention), extracted to a
 * leaf module so both `agent-service.ts` (which populates it) and `agents.ts`
 * (whose entity handles resolve live tasks through it) can import it without
 * importing each other. The AgentTask import below is type-only — erased at
 * runtime — so this module has no runtime dependencies at all.
 */
import type { AgentTask } from "./agent-service";

const taskRegistry = new Map<string, AgentTask>();

export function registerTask(task: AgentTask): void {
  taskRegistry.set(task.taskId, task);
}

export function unregisterTask(taskId: string): void {
  taskRegistry.delete(taskId);
}

export function getRegisteredTask(taskId: string): AgentTask | undefined {
  return taskRegistry.get(taskId);
}
