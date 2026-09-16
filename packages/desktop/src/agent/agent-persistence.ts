/**
 * The task row's persisted shape, validation and boot mapping live in
 * @notefig/shared: the CLI writes the same rows into the same database. This
 * module keeps the desktop's import sites where they were.
 */
export {
  bootAgentTaskRow,
  parsePersistedAgentTask,
  PersistedAgentTaskSchema,
  type PersistedAgentTask,
} from "@notefig/shared/agent";
export { AGENT_TASKS_COLLECTION_ID } from "@notefig/shared/persistence";
