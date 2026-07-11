/**
 * Stage 1 interaction primitives — shared between the desktop agent service
 * and any future consumer (web relay, tests) so the shape has one owner.
 */

/** Result of a prompt handle's `completed` promise (Stage 1, fixes A3). */
export type TurnOutcome =
  | { status: "completed"; stopReason?: string }
  | { status: "error"; error: string }
  | { status: "cancelled" }
  | { status: "superseded" };
