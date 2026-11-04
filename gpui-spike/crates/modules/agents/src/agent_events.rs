//! The moments the agent runtime announces on core's hook bus: a port of
//! `modules/agents/agent-events.ts` (the `"agent:*"` entries of
//! `CoreHookMap`). Each is a moment, not a fact to query later — the agent
//! store remains the source for state. Listeners (prompt rounds, seen, turn
//! writes, usage, history) are not known here.

use notefig_agent::model::{AvailableCommand, SessionConfigSelect, TurnStatus};
use notefig_agent::usage::{TurnUsage, UsageLimits};
use notefig_core::Hook;
use serde_json::Value;

/// `"agent:tool-call"`: a live turn's tool call was reported or moved on
/// (pending → in_progress → completed/failed); `tool_call` is the merged
/// state so far. Never raised for a session/load replay.
pub struct AgentToolCall;
#[derive(Debug, Clone)]
pub struct AgentToolCallEvent {
    pub task_id: String,
    pub turn_id: String,
    /// The task's workspace: what relative tool paths are relative to.
    pub workspace_path: String,
    /// ACP `ToolCallUpdate`, merged.
    pub tool_call: Value,
}
impl Hook for AgentToolCall {
    const NAME: &'static str = "agent:tool-call";
    type Payload = AgentToolCallEvent;
}

/// `"agent:turn-completed"`: a turn finished normally — not cancelled, not
/// failed. Its workspace's history checkpoints it.
pub struct AgentTurnCompleted;
#[derive(Debug, Clone)]
pub struct AgentTurnCompletedEvent {
    pub task_id: String,
    pub turn_id: String,
    pub workspace_path: String,
    /// What the user asked, as typed.
    pub prompt: String,
    pub harness_id: String,
}
impl Hook for AgentTurnCompleted {
    const NAME: &'static str = "agent:turn-completed";
    type Payload = AgentTurnCompletedEvent;
}

/// `"agent:turn-requeued"`: a settled turn went back to the queue to run
/// again (the retry of a prompt a sign-in interrupted).
pub struct AgentTurnRequeued;
#[derive(Debug, Clone)]
pub struct AgentTurnRequeuedEvent {
    pub task_id: String,
    pub turn_id: String,
}
impl Hook for AgentTurnRequeued {
    const NAME: &'static str = "agent:turn-requeued";
    type Payload = AgentTurnRequeuedEvent;
}

/// `"agent:turn-settled"`: a turn reached a terminal status.
pub struct AgentTurnSettled;
#[derive(Debug, Clone)]
pub struct AgentTurnSettledEvent {
    pub task_id: String,
    pub turn_id: String,
    /// `completed`, `cancelled` or `error`.
    pub status: TurnStatus,
    /// The one settle time every record of this turn shares.
    pub at: i64,
}
impl Hook for AgentTurnSettled {
    const NAME: &'static str = "agent:turn-settled";
    type Payload = AgentTurnSettledEvent;
}

/// `"agent:usage"`: what a settled turn added to its session's usage,
/// harness quirks already resolved. Never for a session/load replay. The
/// session total is on the task row; this is for whoever keeps usage
/// beyond the task (the usage module).
pub struct AgentUsage;
#[derive(Debug, Clone)]
pub struct AgentUsageEvent {
    pub task_id: String,
    pub turn_id: String,
    pub workspace_path: String,
    pub harness_id: String,
    pub at: i64,
    pub usage: TurnUsage,
}
impl Hook for AgentUsage {
    const NAME: &'static str = "agent:usage";
    type Payload = AgentUsageEvent;
}

/// `"agent:usage-limits"`: a harness reported where its account stands
/// against its limits. Raised when the report changes.
pub struct AgentUsageLimits;
#[derive(Debug, Clone)]
pub struct AgentUsageLimitsEvent {
    pub task_id: String,
    pub harness_id: String,
    pub at: i64,
    pub limits: UsageLimits,
}
impl Hook for AgentUsageLimits {
    const NAME: &'static str = "agent:usage-limits";
    type Payload = AgentUsageLimitsEvent;
}

/// `"agent:catalog"`: a session reported what its harness offers. Only the
/// half that changed is set.
pub struct AgentCatalog;
#[derive(Debug, Clone)]
pub struct AgentCatalogEvent {
    pub task_id: String,
    pub harness_id: String,
    pub workspace_path: String,
    pub config_options: Option<Vec<SessionConfigSelect>>,
    pub commands: Option<Vec<AvailableCommand>>,
}
impl Hook for AgentCatalog {
    const NAME: &'static str = "agent:catalog";
    type Payload = AgentCatalogEvent;
}

/// The facade's `task(id).open()`: the TS facade calls
/// `core.tabs.openAgent(taskId)`. Deviation: the tabs module is the shell
/// owner's and not a dependency here yet, so the request is announced and
/// the shell (tabs/layout) answers it.
pub struct AgentOpenRequested;
#[derive(Debug, Clone)]
pub struct AgentOpenRequestedEvent {
    pub task_id: String,
    pub workspace_path: String,
}
impl Hook for AgentOpenRequested {
    const NAME: &'static str = "agent:open";
    type Payload = AgentOpenRequestedEvent;
}

/// Emit the hook a runtime event is, if it is one.
pub(crate) fn announce(hooks: &notefig_core::Hooks, event: &crate::runtime::events::AgentEvent) {
    use crate::runtime::events::AgentEvent as E;
    match event.clone() {
        E::ToolCall { task_id, turn_id, workspace_path, tool_call } => {
            hooks.emit::<AgentToolCall>(AgentToolCallEvent { task_id, turn_id, workspace_path, tool_call })
        }
        E::TurnCompleted { task_id, turn_id, workspace_path, prompt, harness_id } => hooks
            .emit::<AgentTurnCompleted>(AgentTurnCompletedEvent { task_id, turn_id, workspace_path, prompt, harness_id }),
        E::TurnRequeued { task_id, turn_id } => {
            hooks.emit::<AgentTurnRequeued>(AgentTurnRequeuedEvent { task_id, turn_id })
        }
        E::TurnSettled { task_id, turn_id, status, at } => {
            hooks.emit::<AgentTurnSettled>(AgentTurnSettledEvent { task_id, turn_id, status, at })
        }
        E::Usage { task_id, turn_id, workspace_path, harness_id, at, usage } => hooks
            .emit::<AgentUsage>(AgentUsageEvent { task_id, turn_id, workspace_path, harness_id, at, usage }),
        E::UsageLimits { task_id, harness_id, at, limits } => {
            hooks.emit::<AgentUsageLimits>(AgentUsageLimitsEvent { task_id, harness_id, at, limits })
        }
        E::Catalog { task_id, harness_id, workspace_path, config_options, commands } => hooks
            .emit::<AgentCatalog>(AgentCatalogEvent { task_id, harness_id, workspace_path, config_options, commands }),
        _ => {}
    }
}
