/**
 * The moments the agent runtime announces on core's hook bus. Each is a
 * moment, not a fact to query later — the collections remain the bus for
 * state. Listeners: prompt rounds, seen, turn writes and each workspace's
 * history; none of them is known here.
 */
import type { AgentTurnStatus, ToolCallUpdate } from "@notefig/shared/agent";

declare module "@notefig/core" {
  interface CoreHookMap {
    /** A prompt widget sent a prompt: a round began in a document. */
    "widget:round-started": {
      taskId: string;
      turnId: string;
      workspacePath: string;
      /** Absolute path of the document the widget lives in. */
      documentPath: string;
      /** The prompt as sent. */
      prompt: string;
    };
    /** A live turn's tool call was reported or moved on (pending →
     *  in_progress → completed/failed); `toolCall` is the merged state so
     *  far. Never raised for a session/load replay. */
    "agent:tool-call": {
      taskId: string;
      turnId: string;
      /** The task's workspace — what relative tool paths are relative to. */
      workspacePath: string;
      toolCall: ToolCallUpdate;
    };
    /** A turn finished normally — not cancelled, not failed. Its
     *  workspace's history checkpoints it. */
    "agent:turn-completed": {
      taskId: string;
      turnId: string;
      workspacePath: string;
      /** What the user asked, as typed. */
      prompt: string;
      harnessId: string;
    };
    /** A turn reached a terminal status. */
    "agent:turn-settled": {
      taskId: string;
      turnId: string;
      status: Extract<AgentTurnStatus, "completed" | "cancelled" | "error">;
      /** The one settle time every record of this turn shares: what the
       *  task row and the prompt round store, and what "seen as it landed"
       *  compares against — so no two listeners' clocks can disagree. */
      at: number;
    };
  }
}
