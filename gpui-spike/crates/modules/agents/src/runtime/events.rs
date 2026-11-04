//! What the UI renders from. Row events carry the whole row (the UI can
//! keep a mirror or just re-read the snapshot through `AgentHandle`); the
//! hook events are the TS app's `CoreHookMap` moments.

use serde_json::Value;

use notefig_agent::model::{
    AgentEntry, AgentTaskRow, AgentTurn, AvailableCommand, PermissionRequestRow,
    SessionConfigSelect, TurnStatus,
};
use notefig_agent::usage::{TurnUsage, UsageLimits};

#[derive(Debug, Clone)]
pub enum AgentEvent {
    TaskChanged(AgentTaskRow),
    TaskRemoved {
        task_id: String,
    },
    TurnChanged(AgentTurn),
    TurnRemoved {
        task_id: String,
        turn_id: String,
    },
    EntryChanged(AgentEntry),
    EntryRemoved {
        task_id: String,
        entry_id: String,
    },
    /// A `session/load` replay committed: re-read the task's turns/entries.
    TranscriptReplaced {
        task_id: String,
    },
    PermissionChanged(PermissionRequestRow),
    /// Harness rows changed (settings, install verdicts, catalog): re-read
    /// `AgentHandle::harness_settings()`.
    HarnessesChanged,
    /// `agent:tool-call` — every state a live turn's tool call reaches.
    ToolCall {
        task_id: String,
        turn_id: String,
        workspace_path: String,
        tool_call: Value,
    },
    /// `agent:turn-settled`.
    TurnSettled {
        task_id: String,
        turn_id: String,
        status: TurnStatus,
        at: i64,
    },
    /// `agent:turn-completed` (history checkpoint moment).
    TurnCompleted {
        task_id: String,
        turn_id: String,
        workspace_path: String,
        prompt: String,
        harness_id: String,
    },
    /// `agent:turn-requeued` (held prompt retried after sign-in).
    TurnRequeued {
        task_id: String,
        turn_id: String,
    },
    /// `agent:usage`.
    Usage {
        task_id: String,
        turn_id: String,
        workspace_path: String,
        harness_id: String,
        at: i64,
        usage: TurnUsage,
    },
    /// `agent:usage-limits`.
    UsageLimits {
        task_id: String,
        harness_id: String,
        at: i64,
        limits: UsageLimits,
    },
    /// `agent:catalog`.
    Catalog {
        task_id: String,
        harness_id: String,
        workspace_path: String,
        config_options: Option<Vec<SessionConfigSelect>>,
        commands: Option<Vec<AvailableCommand>>,
    },
    /// Stderr lines, spawn/turn warnings (console-level observability).
    Diagnostic {
        task_id: Option<String>,
        label: String,
        detail: String,
    },
}
