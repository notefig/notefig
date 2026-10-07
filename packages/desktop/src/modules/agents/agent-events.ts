/**
 * The moments the agent runtime announces on core's hook bus. Each is a
 * moment, not a fact to query later — the collections remain the bus for
 * state. Listeners: prompt rounds, seen, turn writes and each workspace's
 * history; none of them is known here.
 */
import type {
  AgentTurnStatus,
  ToolCallUpdate,
  TurnUsage,
  UsageLimits,
} from "@notefig/shared/agent";

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
    /** What a settled turn added to its session's usage, harness quirks
     *  already resolved. Raised once per live turn that reported anything
     *  (cancelled ones included, when the late response carries usage);
     *  never for a session/load replay. The session's running total is on
     *  its task row — this is for whoever keeps usage beyond the task. */
    "agent:usage": {
      taskId: string;
      turnId: string;
      workspacePath: string;
      harnessId: string;
      /** The turn's settle time, as `agent:turn-settled` carries it. */
      at: number;
      usage: TurnUsage;
    };
    /** A harness reported where its account stands against its limits
     *  (rate-limit windows, plan utilization), vendor shapes already read
     *  into `UsageLimits`. Limits belong to the harness account, not the
     *  session: the task is only where the report arrived. Raised when the
     *  report changes. */
    "agent:usage-limits": {
      taskId: string;
      harnessId: string;
      at: number;
      limits: UsageLimits;
    };
  }
}
