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

/**
 * Something awaiting or carrying a user answer: a question blob, a
 * blocking-tool ask, or an auth block. `entryId` is a required FK to the
 * `AgentEntry` row that originated the interaction — every interaction has
 * one by construction (the tool-call entry, the question-fence entry, or an
 * entry minted for an auth failure).
 */
export interface AgentInteraction {
  id: string;
  taskId: string;
  entryId: string;
  source: "blob" | "tool" | "auth";
  state: "pending" | "answered" | "superseded" | "cancelled";
  question: string;
  answer?: string;
  blobRef?: string;
  toolCallId?: string;
  createdAt: number;
}
