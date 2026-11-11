/**
 * Which mark a session gets (MET-284): one of the theme's session colors and
 * one of the widgets' shapes. The mark is the session's on every widget that
 * joins it, in the sessions panel, and (its color) on the edits it leaves in
 * the document, so it is picked once, when the row is made, and kept:
 * `colorSlot` and `shapeSlot` on the task row.
 */
import {
  SESSION_COLOR_SLOTS,
  SESSION_SHAPES,
  type AgentTaskRow,
} from "@notefig/shared/agent";
import { workspaceKey } from "@/utils/path";

type Held = Pick<
  AgentTaskRow,
  "taskId" | "workspacePath" | "status" | "updatedAt" | "colorSlot" | "shapeSlot"
>;
type SlotKey = "colorSlot" | "shapeSlot";

/**
 * A color and a shape no other live session of the workspace holds: twelve
 * sessions never share a color, and twenty-four never share a shape, so no
 * two share a mark until there are more than twenty-four. An unavailable
 * session (its harness session is gone) holds none. When every slot of one
 * kind is held, the one of the session left untouched longest is reused.
 */
export function pickSessionMark(
  rows: Iterable<Held>,
  workspacePath: string,
  taskId?: string,
): { colorSlot: number; shapeSlot: number } {
  const workspace = workspaceKey(workspacePath);
  const live = [...rows].filter((row) => holds(row, workspace, taskId));
  return {
    colorSlot: pickSlot(live, "colorSlot", SESSION_COLOR_SLOTS),
    shapeSlot: pickSlot(live, "shapeSlot", SESSION_SHAPES),
  };
}

/** The lowest free slot of one kind, else the stalest held one. */
function pickSlot(live: Held[], key: SlotKey, count: number): number {
  const holders = heldSlots(live, key);
  for (let slot = 0; slot < count; slot++) {
    if (!holders.has(slot)) return slot;
  }
  return stalestSlot(holders);
}

/** Each slot of one kind the live sessions hold, with the latest activity
 *  of any session holding it. */
function heldSlots(live: Held[], key: SlotKey): Map<number, number> {
  const holders = new Map<number, number>();
  for (const row of live) {
    const slot = row[key];
    if (slot === undefined) continue;
    holders.set(slot, Math.max(holders.get(slot) ?? -Infinity, row.updatedAt));
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
