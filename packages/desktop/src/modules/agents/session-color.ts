/**
 * Which of the theme's session colors a session gets (MET-284). The slot is
 * the session's color and letter on every widget that joins it and on the
 * edits it leaves in the document, so it is picked once, when the row is
 * made, and kept: `colorSlot` on the task row.
 */
import { SESSION_COLOR_SLOTS, type AgentTaskRow } from "@notefig/shared/agent";
import { workspaceKey } from "@/utils/path";

type Held = Pick<AgentTaskRow, "taskId" | "workspacePath" | "status" | "updatedAt" | "colorSlot">;

/**
 * The lowest slot no other session of the workspace holds, so the sessions
 * of one workspace never share a color while there are six or fewer. An
 * unavailable session (its harness session is gone) holds none. When every
 * slot is held, the one of the session left untouched longest is reused.
 */
export function pickColorSlot(
  rows: Iterable<Held>,
  workspacePath: string,
  taskId?: string,
): number {
  const holders = heldSlots(rows, workspaceKey(workspacePath), taskId);
  for (let slot = 0; slot < SESSION_COLOR_SLOTS; slot++) {
    if (!holders.has(slot)) return slot;
  }
  return stalestSlot(holders);
}

/** Each slot the workspace's other sessions hold, with the latest activity
 *  of any session holding it. */
function heldSlots(
  rows: Iterable<Held>,
  workspace: string,
  taskId: string | undefined,
): Map<number, number> {
  const holders = new Map<number, number>();
  for (const row of rows) {
    if (row.colorSlot === undefined || !holds(row, workspace, taskId)) continue;
    holders.set(row.colorSlot, Math.max(holders.get(row.colorSlot) ?? -Infinity, row.updatedAt));
  }
  return holders;
}

function holds(row: Held, workspace: string, taskId: string | undefined): boolean {
  return (
    row.taskId !== taskId &&
    row.status !== "unavailable" &&
    workspaceKey(row.workspacePath) === workspace
  );
}

/** The held slot whose latest activity is oldest. */
function stalestSlot(holders: Map<number, number>): number {
  let stalest = 0;
  for (const [slot, at] of holders) {
    if (at < holders.get(stalest)!) stalest = slot;
  }
  return stalest;
}
