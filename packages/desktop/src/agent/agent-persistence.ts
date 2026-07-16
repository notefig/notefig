/**
 * Persistence shape for agent task rows (MET-54). The tasks collection is
 * storage-backed (agent-collections.ts: a query collection over the KV seam,
 * write-through on every mutation — the same unified-storage idiom as the
 * file collections over fs), so there is no mirror, no restore step, and no
 * sync choreography. This module owns only the pure parts: the persisted
 * schema, validate-on-read, and the boot mapping that turns a stored row
 * back into a live one.
 */
import { z } from "zod";
import type { AgentTaskRow } from "./agent-collections";

export const AGENT_TASKS_NAMESPACE = "agent-tasks";

/**
 * Full-row persistence: what's written is the collection row itself (plus
 * whatever runtime fields happened to be on it — tolerated on read via
 * passthrough, dropped by the boot mapping). kv.json is a plain on-disk
 * file; anything hand-edited into garbage is dropped instead of reaching
 * revival/spawn.
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

export function parsePersistedAgentTasks(
  raw: Record<string, unknown>,
): PersistedAgentTask[] {
  const rows: PersistedAgentTask[] = [];
  for (const value of Object.values(raw)) {
    const parsed = PersistedAgentTaskSchema.safeParse(value);
    if (parsed.success) rows.push(parsed.data);
  }
  return rows;
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

/** Rows carry TanStack's enumerable `$`-prefixed virtual props (`$synced`,
 *  `$origin`, …) — strip them so kv.json stores plain data. */
export function persistableAgentTaskRow(
  row: AgentTaskRow,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).filter(([key]) => !key.startsWith("$")),
  );
}
