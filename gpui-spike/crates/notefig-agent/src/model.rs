//! The task / turn / entry / permission model (port of
//! `shared/src/agent/task-state.ts`) plus the few ACP payload shapes the
//! rows carry. Payloads the app renders but this crate only passes through
//! keep their raw JSON (`Value`) so nothing a harness sends is lost; typed
//! views ([`ToolCallView`], [`PlanView`]) read them for the UI.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::usage::{SessionUsage, TurnUsage};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    Starting,
    Idle,
    Running,
    Cancelled,
    Error,
    /// Persisted session restored after a restart — live but unspawned;
    /// the first interaction revives it via ACP `session/load`.
    Restored,
    /// Revival failed (the harness no longer has the session): read-only,
    /// deletable.
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TurnStatus {
    Queued,
    Running,
    Completed,
    Cancelled,
    Error,
}

impl TurnStatus {
    pub fn is_ended(self) -> bool {
        matches!(
            self,
            TurnStatus::Completed | TurnStatus::Cancelled | TurnStatus::Error
        )
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LastSettled {
    pub turn_id: String,
    pub at: i64,
    /// `completed` or `error` (never `cancelled`).
    pub status: TurnStatus,
}

/// An ACP `AuthMethod` (`{id, name, description?}` + anything else).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AuthMethod {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// One choice of a select config option.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConfigChoice {
    pub value: String,
    #[serde(default)]
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// A group of choices (ACP allows `options` to be grouped).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConfigGroup {
    #[serde(default)]
    pub group: String,
    #[serde(default)]
    pub name: String,
    pub options: Vec<ConfigChoice>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ConfigOptions {
    Flat(Vec<ConfigChoice>),
    Grouped(Vec<ConfigGroup>),
}

/// ACP `SessionConfigSelect`: a switchable session setting (model, mode,
/// thought level…). Only `select` options are kept (booleans are dropped
/// as in the TS client).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionConfigSelect {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// `model`, `mode`, `thought_level`, …
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(rename = "type", default = "select_type")]
    pub kind: String,
    pub current_value: Value,
    pub options: ConfigOptions,
}

fn select_type() -> String {
    "select".into()
}

impl SessionConfigSelect {
    /// Every choice, flattened across groups.
    pub fn choices(&self) -> Vec<&ConfigChoice> {
        match &self.options {
            ConfigOptions::Flat(choices) => choices.iter().collect(),
            ConfigOptions::Grouped(groups) => {
                groups.iter().flat_map(|g| g.options.iter()).collect()
            }
        }
    }
    pub fn current(&self) -> Option<&str> {
        self.current_value.as_str()
    }
}

/// ACP `AvailableCommand` (slash commands and skills).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AvailableCommand {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// One task row. Persisted fields + runtime-only ones (stripped at boot).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTaskRow {
    /// `task_` (descending id).
    pub task_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_task_id: Option<String>,
    pub workspace_path: String,
    pub title: String,
    pub status: TaskStatus,
    pub harness_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub created_at: i64,
    /// Bumped on insert, status changes and prompt enqueue — never per chunk.
    pub updated_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_settled: Option<LastSettled>,
    /// Durable: the session total + latest context fill.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<SessionUsage>,
    // ── runtime-only ──
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_hint: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub auth_required: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub auth_methods: Vec<AuthMethod>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_options: Option<Vec<SessionConfigSelect>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commands: Option<Vec<AvailableCommand>>,
}

impl AgentTaskRow {
    /// The persisted projection: runtime-only fields dropped.
    pub fn persisted(&self) -> AgentTaskRow {
        AgentTaskRow {
            auth_hint: None,
            auth_required: false,
            auth_methods: vec![],
            config_options: None,
            commands: None,
            ..self.clone()
        }
    }

    /// The boot mapping (`bootAgentTaskRow`): a stored row for a task with
    /// no live runtime comes back `restored`, runtime fields dropped; None
    /// (delete it) when it never got a session.
    pub fn boot(&self) -> Option<AgentTaskRow> {
        self.session_id.as_ref()?;
        Some(AgentTaskRow {
            status: TaskStatus::Restored,
            ..self.persisted()
        })
    }

    /// The session's current model, from its model config option.
    pub fn current_model(&self) -> Option<String> {
        self.config_options
            .as_ref()?
            .iter()
            .find(|o| o.category.as_deref() == Some("model"))?
            .current()
            .map(str::to_string)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTurn {
    /// `trn_` (ascending).
    pub turn_id: String,
    pub task_id: String,
    /// Empty while queued on a task whose session isn't up yet.
    pub session_id: String,
    pub status: TurnStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub started_at: i64,
    /// Absent until the turn settles (and on replay); `Some(None)` when the
    /// harness reported nothing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<Option<TurnUsage>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EntryType {
    User,
    Assistant,
    /// Coalesced `agent_thought_chunk` run.
    Thought,
    ToolCall,
    Plan,
    Unknown,
}

/// One transcript item. Ids are ascending, so id order IS render order
/// (`created_at` is absent on replay and must never be used to order).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEntry {
    pub id: String,
    pub task_id: String,
    pub turn_id: String,
    #[serde(rename = "type")]
    pub kind: EntryType,
    /// user / assistant / thought text; unknown: the update's kind.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// The coalesced ACP tool call (raw JSON; see [`ToolCallView`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call: Option<Value>,
    /// The latest `plan` update (raw; see [`PlanView`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<Value>,
    /// unknown: the whole session update, verbatim.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<i64>,
}

impl AgentEntry {
    pub fn tool_call_view(&self) -> Option<ToolCallView> {
        self.tool_call.as_ref().map(ToolCallView::from_value)
    }
    pub fn plan_view(&self) -> Option<PlanView> {
        self.plan.as_ref().map(PlanView::from_value)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PermissionStatus {
    Pending,
    Granted,
    Denied,
    Cancelled,
}

/// ACP `PermissionOption`, kept verbatim for the card.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionOption {
    pub option_id: String,
    #[serde(default)]
    pub name: String,
    /// `allow_once` | `allow_always` | `reject_once` | `reject_always`.
    #[serde(default)]
    pub kind: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequestRow {
    /// `<taskId>_perm_<n>`.
    pub id: String,
    pub task_id: String,
    pub session_id: String,
    pub title: String,
    pub options: Vec<PermissionOption>,
    /// The tool call the request is about, verbatim.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call: Option<Value>,
    pub status: PermissionStatus,
}

/// How the app answers a permission request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PermissionOutcome {
    Selected(String),
    Cancelled,
}

impl PermissionOutcome {
    pub fn to_json(&self) -> Value {
        match self {
            PermissionOutcome::Selected(id) => {
                serde_json::json!({"outcome": {"outcome": "selected", "optionId": id}})
            }
            PermissionOutcome::Cancelled => {
                serde_json::json!({"outcome": {"outcome": "cancelled"}})
            }
        }
    }
}

/// How a prompt ended (the prompt handle's `completed`).
#[derive(Debug, Clone, PartialEq)]
pub enum TurnOutcome {
    Completed { stop_reason: Option<String> },
    Cancelled,
    Error(String),
}

// ─── Typed views over raw payloads ──────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub enum ToolCallContentView {
    /// A content block (usually `{type:"text", text}`).
    Content(Value),
    Diff {
        path: String,
        old_text: Option<String>,
        new_text: String,
    },
    /// Terminals aren't implemented; rendered as a placeholder.
    Terminal {
        terminal_id: String,
    },
    Other(Value),
}

#[derive(Debug, Clone, PartialEq)]
pub struct ToolCallView {
    pub tool_call_id: String,
    pub title: Option<String>,
    /// `read`, `edit`, `delete`, `move`, `search`, `execute`, `think`, `fetch`, `other`.
    pub kind: Option<String>,
    /// `pending`, `in_progress`, `completed`, `failed`.
    pub status: Option<String>,
    pub content: Vec<ToolCallContentView>,
    pub locations: Vec<String>,
    pub raw_input: Option<Value>,
    pub raw_output: Option<Value>,
}

impl ToolCallView {
    pub fn from_value(value: &Value) -> ToolCallView {
        let str_field = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_string);
        let content = value
            .get("content")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .map(|item| match item.get("type").and_then(Value::as_str) {
                        Some("content") => ToolCallContentView::Content(
                            item.get("content").cloned().unwrap_or(Value::Null),
                        ),
                        Some("diff") => ToolCallContentView::Diff {
                            path: item
                                .get("path")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .into(),
                            old_text: item
                                .get("oldText")
                                .and_then(Value::as_str)
                                .map(str::to_string),
                            new_text: item
                                .get("newText")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .into(),
                        },
                        Some("terminal") => ToolCallContentView::Terminal {
                            terminal_id: item
                                .get("terminalId")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .into(),
                        },
                        _ => ToolCallContentView::Other(item.clone()),
                    })
                    .collect()
            })
            .unwrap_or_default();
        let locations = value
            .get("locations")
            .and_then(Value::as_array)
            .map(|l| {
                l.iter()
                    .filter_map(|loc| loc.get("path")?.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        ToolCallView {
            tool_call_id: str_field("toolCallId").unwrap_or_default(),
            title: str_field("title"),
            kind: str_field("kind"),
            status: str_field("status"),
            content,
            locations,
            raw_input: value.get("rawInput").cloned(),
            raw_output: value.get("rawOutput").cloned(),
        }
    }

    /// `edit`/`delete`/`move` kinds, or any diff content (`isMutatingToolCall`).
    pub fn is_mutating(&self) -> bool {
        matches!(self.kind.as_deref(), Some("edit" | "delete" | "move"))
            || self
                .content
                .iter()
                .any(|c| matches!(c, ToolCallContentView::Diff { .. }))
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct PlanEntryView {
    pub content: String,
    pub priority: Option<String>,
    pub status: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PlanView {
    pub entries: Vec<PlanEntryView>,
}

impl PlanView {
    pub fn from_value(value: &Value) -> PlanView {
        let entries = value
            .get("entries")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .map(|e| PlanEntryView {
                        content: e
                            .get("content")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .into(),
                        priority: e
                            .get("priority")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        status: e.get("status").and_then(Value::as_str).map(str::to_string),
                    })
                    .collect()
            })
            .unwrap_or_default();
        PlanView { entries }
    }
}

/// Sort entries into render order (id order).
pub fn sort_entries(entries: &mut [AgentEntry]) {
    entries.sort_by(|a, b| a.id.cmp(&b.id));
}

/// Text of a content block (`text` blocks only).
pub fn content_block_text(content: &Value) -> &str {
    if content.get("type").and_then(Value::as_str) == Some("text") {
        content.get("text").and_then(Value::as_str).unwrap_or("")
    } else {
        ""
    }
}
