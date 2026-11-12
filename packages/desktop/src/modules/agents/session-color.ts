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
 * A color and a shape no other live session of the workspace holds, at
 * random among those free: twelve sessions never share a color, and
 * twenty-four never share a shape, so no two share a mark until there are
 * more than twenty-four, and a new workspace's first session isn't always
 * the same mark. An unavailable session (its harness session is gone)
 * holds none. When every slot of one kind is held, the one of the session
 * left untouched longest is reused. `random` is Math.random's shape (tests
 * pass their own).
 */
export function pickSessionMark(
  rows: Iterable<Held>,
  workspacePath: string,
  taskId?: string,
  random: () => number = Math.random,
): { colorSlot: number; shapeSlot: number } {
  const workspace = workspaceKey(workspacePath);
  const live = [...rows].filter((row) => holds(row, workspace, taskId));
  return {
    colorSlot: pickSlot(live, "colorSlot", SESSION_COLOR_SLOTS, random),
    shapeSlot: pickSlot(live, "shapeSlot", SESSION_SHAPES, random),
  };
}

/** A free slot of one kind, at random, else the stalest held one. */
function pickSlot(live: Held[], key: SlotKey, count: number, random: () => number): number {
  const holders = heldSlots(live, key);
  const free = Array.from({ length: count }, (_, slot) => slot).filter(
    (slot) => !holders.has(slot),
  );
  if (free.length === 0) return stalestSlot(holders);
  return free[Math.min(free.length - 1, Math.floor(random() * free.length))];
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
