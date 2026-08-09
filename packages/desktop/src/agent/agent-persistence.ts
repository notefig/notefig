/**
 * Persistence shape for agent task rows (MET-54, re-based on SQLite in
 * MET-124). The tasks collection is a persisted local-only collection
 * (agent-collections.ts) — SQLite *is* its source of truth, so there is no
 * mirror, no restore step, and no sync choreography. This module owns only the
 * pure parts: the persisted schema, validate-on-read, and the boot mapping that
 * turns a stored row back into a live one.
 */
import { z } from "zod";
import type { AgentTaskRow } from "./agent-collections";

/** The collection id, and so the SQLite table this data lands in. */
export const AGENT_TASKS_COLLECTION_ID = "agent-tasks";

/**
 * Full-row persistence: what's written is the collection row itself (plus
 * whatever runtime fields happened to be on it — tolerated on read via
 * passthrough, dropped by the boot mapping). Validate-on-read survives the move
 * off hand-editable kv.json: a row can still predate a schema change, and a
 * garbage row must be dropped rather than reach revival/spawn.
 */
export const PersistedAgentTaskSchema = z
  .object({
    taskId: z.string().min(1),
    parentTaskId: z.string().min(1).optional(),
    workspacePath: z.string().min(1),
    title: z.string(),
    // Default, not required: rows written before full-row persistence
    // (2026-07-15) carry no status — they load as plain restorable rows.
    status: z.string().default("restored"),
    harnessId: z.string().min(1),
    sessionId: z.string().min(1).optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .passthrough();

export type PersistedAgentTask = z.infer<typeof PersistedAgentTaskSchema>;

/** A single stored row, or null if it is not one we can trust. */
export function parsePersistedAgentTask(
  value: unknown,
): PersistedAgentTask | null {
  const parsed = PersistedAgentTaskSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * A stored row for a task with NO live runtime, as it should enter the
 * collection: status "restored" (live-but-unspawned — first interaction
 * revives it via session/load), runtime-only fields dropped. Null when the
 * task never got a session — there is nothing to revive.
 */
export function bootAgentTaskRow(row: PersistedAgentTask): AgentTaskRow | null {
  if (!row.sessionId) return null;
  return {
    taskId: row.taskId,
    ...(row.parentTaskId ? { parentTaskId: row.parentTaskId } : {}),
    workspacePath: row.workspacePath,
    title: row.title,
    status: "restored",
    harnessId: row.harnessId,
    sessionId: row.sessionId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
