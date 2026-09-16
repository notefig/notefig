/**
 * The identity of every persisted collection more than one process opens.
 *
 * A collection's id is its SQLite table (the library derives the table name
 * from it), so a host that spells an id differently is not reading the same
 * data — it is silently reading an empty table. Defining the id and key once
 * here is what makes the desktop and the CLI two views of one store.
 */
import type { AgentTaskRow } from "../agent/task-state";

/** The agent task rows. */
export const AGENT_TASKS_COLLECTION_ID = "agent-tasks";

export const agentTasksCollectionIdentity = {
  id: AGENT_TASKS_COLLECTION_ID,
  getKey: (task: AgentTaskRow) => task.taskId,
} as const;

/** A namespaced key-value row. Settings-sized data; see desktop kv-store.ts. */
export interface KvRow {
  key: string;
  value: unknown;
}

/** Explicit, always: an omitted id defaults to a random UUID, which writes to
 *  a fresh table every launch. */
export function kvCollectionIdentity(namespace: string) {
  return {
    id: `kv:${namespace}`,
    getKey: (row: KvRow) => row.key,
  } as const;
}
