//! Prompt rounds: every prompt-widget turn across the open workspaces, a
//! port of `packages/desktop/src/modules/prompt-rounds/` — `core.promptRounds`.
//!
//! A persisted row per round (the platform db collection `prompt-rounds`),
//! written by one global listener: `widget:round-started` when a widget
//! sends, `agent:turn-settled` when the turn ends, `agent:turn-requeued`
//! when it runs again. A row still `live` at boot belongs to a turn the
//! previous run never finished: settled as cancelled. A round is also its
//! widget's record (MET-251): the settled face reads the outcome
//! snapshotted here. Settled rounds are kept a week, at most 100 rows.
//!
//! `react.ts` (`usePromptRounds`) is the view's: it calls
//! [`derive_prompt_rounds`] over this collection, the open set and the
//! agent store's turns.
//!
//! Deviation: this module hands its stored rounds to the prompt widgets
//! service in `boot` (see `notefig-prompt-widgets`' crate doc for why the
//! `needs` edge is turned around).

mod rounds;
#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::rc::Rc;

use notefig_agent::model::TurnStatus;
use notefig_agents::AgentStoreModule;
use notefig_core::{Module, ModuleContext, ModuleRef, Subscription};
use notefig_platform::PlatformService;
use notefig_prompt_widgets::{PromptWidgetsModule, RecordStatus, RoundOutcome, round_status};
use serde::{Deserialize, Serialize};

pub use rounds::{PromptRoundsApi, PromptRoundsDeps, create_prompt_rounds};

pub const PROMPT_ROUNDS_COLLECTION_ID: &str = "prompt-rounds";
/// Rows kept across every workspace (a widget's newest round inside the
/// retention window is never dropped for it).
pub const MAX_PROMPT_ROUNDS: usize = 100;
/// How long a settled round is kept.
pub const PROMPT_ROUND_RETENTION_MS: i64 = 7 * 24 * 60 * 60 * 1000;

/// `PromptRoundRowStatus`: `live` until the turn settles.
pub type PromptRoundRowStatus = RecordStatus;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChangeRange {
    pub from: i64,
    pub to: i64,
}

/// The ranges a round changed in one document, with the fingerprint of the
/// document they were mapped onto.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoundChanges {
    pub document_path: String,
    pub fingerprint: String,
    pub ranges: Vec<ChangeRange>,
}

/// One stored round.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptRoundRow {
    /// The turn id: the row id.
    pub turn_id: String,
    pub task_id: String,
    pub workspace_key: String,
    pub document_path: String,
    /// The prompt as sent, first line.
    pub prompt: String,
    pub status: PromptRoundRowStatus,
    pub started_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settled_at: Option<i64>,
    /// The widget that sent it; absent on rows from before MET-251.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blob_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
    /// The prompt as typed, whole and with its directives.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub typed_prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<RoundOutcome>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub changes: Option<Vec<RoundChanges>>,
}

/// A round as lists show it.
#[derive(Debug, Clone, PartialEq)]
pub struct PromptRound {
    pub turn_id: String,
    pub task_id: String,
    pub workspace_path: String,
    pub document_path: String,
    pub prompt: String,
    pub status: TurnStatus,
    pub started_at: i64,
}

/// A round's status note as an i18n key, or `None` once it completed.
/// Deviation: TS returns the translated text; the view translates the key
/// through `notefig-i18n`.
pub fn describe_prompt_round(status: TurnStatus) -> Option<&'static str> {
    match status {
        TurnStatus::Running => Some("agentRunning"),
        TurnStatus::Queued => Some("roundQueued"),
        TurnStatus::Cancelled => Some("roundCancelled"),
        TurnStatus::Error => Some("agentFailed"),
        TurnStatus::Completed => None,
    }
}

/// Still moving: in flight or waiting its turn.
pub fn is_live_round(status: TurnStatus) -> bool {
    matches!(status, TurnStatus::Running | TurnStatus::Queued)
}

/// The rows to drop: settled rows past retention, then the oldest over the
/// cap, except each widget's newest round.
pub fn rounds_to_evict(rows: &[PromptRoundRow], now: i64) -> Vec<String> {
    let expired = |row: &PromptRoundRow| {
        row.status != RecordStatus::Live && now - row.settled_at.unwrap_or(row.started_at) > PROMPT_ROUND_RETENTION_MS
    };
    let mut doomed: Vec<String> = rows.iter().filter(|r| expired(r)).map(|r| r.turn_id.clone()).collect();
    let mut kept: Vec<&PromptRoundRow> = rows.iter().filter(|r| !doomed.contains(&r.turn_id)).collect();
    kept.sort_by_key(|r| r.started_at);
    let mut newest_by_widget: HashMap<&str, &str> = HashMap::new();
    for row in &kept {
        if let Some(blob) = &row.blob_id {
            newest_by_widget.insert(blob, &row.turn_id);
        }
    }
    let protected: Vec<&str> = newest_by_widget.into_values().collect();
    let mut excess = kept.len() as i64 - MAX_PROMPT_ROUNDS as i64;
    for row in kept {
        if excess <= 0 {
            break;
        }
        if protected.contains(&row.turn_id.as_str()) {
            continue;
        }
        doomed.push(row.turn_id.clone());
        excess -= 1;
    }
    doomed
}

/// The stored rows joined to the open set (`(key, path)`) and to their turn
/// rows (`(turn id, status)`): live rounds first, then newest first.
pub fn derive_prompt_rounds(
    rows: &[PromptRoundRow],
    open_workspaces: &[(String, String)],
    turns: &[(String, TurnStatus)],
) -> Vec<PromptRound> {
    let path_by_key: HashMap<&str, &str> = open_workspaces.iter().map(|(k, p)| (k.as_str(), p.as_str())).collect();
    let turn_by_id: HashMap<&str, TurnStatus> = turns.iter().map(|(id, s)| (id.as_str(), *s)).collect();
    let mut rounds: Vec<PromptRound> = rows
        .iter()
        .filter_map(|row| {
            let workspace_path = path_by_key.get(row.workspace_key.as_str())?;
            // A listed round's turn row, when it has none, is gone for good.
            let status = round_status(Some(row.status), turn_by_id.get(row.turn_id.as_str()).copied(), true)
                .unwrap_or(TurnStatus::Cancelled);
            Some(PromptRound {
                turn_id: row.turn_id.clone(),
                task_id: row.task_id.clone(),
                workspace_path: workspace_path.to_string(),
                document_path: row.document_path.clone(),
                prompt: row.prompt.clone(),
                status,
                started_at: row.started_at,
            })
        })
        .collect();
    rounds.sort_by(|a, b| is_live_round(b.status).cmp(&is_live_round(a.status)).then(b.started_at.cmp(&a.started_at)));
    rounds
}

/// `promptRoundsModule`: settles orphaned rounds, then follows prompt events.
pub struct PromptRoundsModule;

impl Module for PromptRoundsModule {
    const NAME: &'static str = "promptRounds";
    type Api = PromptRoundsApi;
    type Workspace = ();

    fn needs() -> Vec<ModuleRef> {
        vec![
            ModuleRef::service::<PlatformService>(),
            ModuleRef::of::<AgentStoreModule>(),
            ModuleRef::of::<PromptWidgetsModule>(),
        ]
    }

    fn register(ctx: &ModuleContext) -> PromptRoundsApi {
        let store = ctx.use_::<AgentStoreModule>();
        let transcript_store = store.clone();
        create_prompt_rounds(PromptRoundsDeps {
            db: ctx.service::<PlatformService>().db.clone(),
            turn: Rc::new(move |turn_id| store.turn(turn_id)),
            transcript: Rc::new(move |task_id, turn_id| {
                transcript_store.entries(task_id).into_iter().filter(|e| e.turn_id == turn_id).collect()
            }),
            hooks: ctx.hooks().clone(),
            executor: ctx.executor(),
        })
    }

    fn boot(api: &Rc<PromptRoundsApi>, ctx: &ModuleContext) -> Option<Subscription> {
        ctx.use_::<PromptWidgetsModule>().attach_stored_rounds(Rc::new((**api).clone()));
        Some(api.track())
    }
}
