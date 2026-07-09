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
 * Something awaiting or carrying a user answer: a blocking-tool ask, or an
 * auth block. `entryId` is a required FK to the `AgentEntry` row that
 * originated the interaction — every interaction has one by construction
 * (the tool-call entry, or an entry minted for an auth failure).
 *
 * Question/approval blobs are NOT an interaction source: once the agent
 * authors one, that turn is done — there's nothing pending to track. The
 * user's later answer addresses the authoring task directly with a fresh
 * prompt (`findBlobAuthorTask` + `answerBlob` in blob-actions.ts) instead of
 * flowing through this state machine.
 */
export interface AgentInteraction {
  id: string;
  taskId: string;
  entryId: string;
  source: "tool" | "auth";
  state: "pending" | "answered" | "superseded" | "cancelled";
  question: string;
  answer?: string;
  toolCallId?: string;
  createdAt: number;
}
