/**
 * Message format for internal-history checkpoint commits.
 *
 * The commit itself is the only durable record linking a checkpoint to the
 * conversation that produced it: turn/entry rows are ephemeral (rebuilt with
 * fresh ids by session replay), only task rows persist. So the linkage is
 * encoded as git trailers on the commit message — subject stays the
 * human-readable label (the prompt), trailers carry the join keys.
 */

export type CheckpointRole = "user" | "agent";

/**
 * Commit author for user-attributed checkpoints (manual saves, jump safety
 * commits, pre-turn edit folds). Lives in this leaf so agent-service can
 * share it without importing entities/history (which imports agent-service).
 */
export const USER_CHECKPOINT_AUTHOR = {
  name: "user",
  email: "user@notefig.local",
};

export interface CheckpointMessageFields {
  subject: string;
  role: CheckpointRole;
  taskId?: string;
  turnId?: string;
}

const ROLE_TRAILER = "Notefig-Role";
const TASK_TRAILER = "Notefig-Task";
const TURN_TRAILER = "Notefig-Turn";

/** Single-line, trailer-safe subject: strip newlines, cap length. */
function toSubject(text: string): string {
  const singleLine = text.replace(/\s*\n\s*/g, " ").trim();
  return singleLine.length > 72 ? `${singleLine.slice(0, 69)}…` : singleLine;
}

export function formatCheckpointMessage(
  fields: CheckpointMessageFields,
): string {
  const trailers = [
    fields.taskId ? `${TASK_TRAILER}: ${fields.taskId}` : null,
    fields.turnId ? `${TURN_TRAILER}: ${fields.turnId}` : null,
    `${ROLE_TRAILER}: ${fields.role}`,
  ].filter(Boolean);
  return `${toSubject(fields.subject)}\n\n${trailers.join("\n")}\n`;
}

/**
 * Parse a checkpoint commit message back into its fields. Tolerant of
 * commits written before trailers existed (or by other authors): missing
 * trailers yield `role: "agent"` with no ids, and the subject is always
 * the first line.
 */
export function parseCheckpointMessage(
  message: string,
): CheckpointMessageFields {
  const lines = message.split("\n");
  const fields: CheckpointMessageFields = {
    subject: (lines[0] ?? "").trim(),
    role: "agent",
  };
  for (const line of lines.slice(1)) {
    const match = line.match(/^(Notefig-(?:Role|Task|Turn)):\s*(.+)$/);
    if (!match) continue;
    const value = match[2].trim();
    if (match[1] === ROLE_TRAILER && (value === "user" || value === "agent")) {
      fields.role = value;
    } else if (match[1] === TASK_TRAILER) {
      fields.taskId = value;
    } else if (match[1] === TURN_TRAILER) {
      fields.turnId = value;
    }
  }
  return fields;
}
