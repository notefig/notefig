//! `utils/attention.ts`: the attention model as a pure function of rows.
//!
//! Nothing announces "needs attention". Every participating entity keeps
//! the durable fact it already owns — a task row's `last_settled`, a prompt
//! round's `settled_at`, a pending permission, the auth flag — and this
//! joins those against `seen` (when the user last looked at where the thing
//! lives).
//!
//! Two kinds: **bau** (a turn finished; clears when looked at) and
//! **error** (a failed turn, a harness that never came up, a session that
//! has gone — each clears when looked at — and asks: permission, sign-in,
//! a widget's question, which clear when answered). A widget round lands on
//! its document, never on its session.

use std::collections::{BTreeMap, HashMap, HashSet};

use notefig_agent::model::{AgentTaskRow, LastSettled, PermissionRequestRow, PermissionStatus, TaskStatus, TurnStatus};
use notefig_prompt_rounds::PromptRoundRow;
use notefig_prompt_widgets::RecordStatus;
use notefig_seen::{SeenTarget, seen_key};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum AttentionKind {
    Bau,
    Error,
}

/// A question the agent is blocked on; answered where the item jumps to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttentionAsk {
    Permission,
    Auth,
    Question,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AttentionItem {
    pub target: SeenTarget,
    pub kind: AttentionKind,
    pub task_id: String,
    pub turn_id: Option<String>,
    pub since: i64,
    pub workspace_key: String,
    pub ask: Option<AttentionAsk>,
    /// The head of the task's pending permission queue (ask `Permission`).
    pub permission: Option<PermissionRequestRow>,
    /// The task row, for what an ask says about itself.
    pub task: Option<AgentTaskRow>,
    /// The question a widget round asks (ask `Question`).
    pub question: Option<String>,
}

/// `Attention`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Attention {
    /// Newest first.
    pub items: Vec<AttentionItem>,
    /// The questions, for the one card that lists them.
    pub asks: Vec<AttentionItem>,
    pub by_task: BTreeMap<String, AttentionKind>,
    pub by_round: BTreeMap<String, AttentionKind>,
    /// The most pressing kind over everything: the sidebar's one dot.
    pub overall: Option<AttentionKind>,
    /// Per workspace key: items of kind `Error` (the rail's badge).
    pub by_workspace: BTreeMap<String, usize>,
}

/// The rows attention is derived from.
pub struct AttentionRows<'a> {
    pub tasks: &'a [AgentTaskRow],
    pub rounds: &'a [PromptRoundRow],
    /// `(task_id, turn_id)` of every running turn.
    pub running_turns: &'a [(String, String)],
    pub open_workspace_keys: &'a HashSet<String>,
    pub pending_permissions: &'a [PermissionRequestRow],
    /// `seen_key(target)` → when it was last looked at.
    pub seen: &'a HashMap<String, i64>,
    /// `workspaceKey(path)`.
    pub workspace_key: &'a dyn Fn(&str) -> String,
}

fn last_seen_at(seen: &HashMap<String, i64>, target: &SeenTarget) -> i64 {
    seen.get(&seen_key(target)).copied().unwrap_or(0)
}

fn is_working(task: &AgentTaskRow) -> bool {
    matches!(task.status, TaskStatus::Running | TaskStatus::Starting)
}

/// `mostPressing`: error outranks bau.
pub fn most_pressing(a: Option<AttentionKind>, b: Option<AttentionKind>) -> Option<AttentionKind> {
    if a == Some(AttentionKind::Error) || b == Some(AttentionKind::Error) {
        return Some(AttentionKind::Error);
    }
    a.or(b)
}

/// Pending permission requests per task, oldest first (ids sort chronological).
fn head_permission_by_task(pending: &[PermissionRequestRow]) -> HashMap<String, PermissionRequestRow> {
    let mut sorted: Vec<&PermissionRequestRow> =
        pending.iter().filter(|r| r.status == PermissionStatus::Pending).collect();
    sorted.sort_by(|a, b| a.id.cmp(&b.id));
    let mut heads = HashMap::new();
    for request in sorted {
        heads.entry(request.task_id.clone()).or_insert_with(|| request.clone());
    }
    heads
}

/// An error or absence no turn produced: a harness that never came up, a
/// load failure, a process that died while idle.
fn is_error_no_turn_produced(task: &AgentTaskRow) -> bool {
    task.status == TaskStatus::Unavailable
        || (task.status == TaskStatus::Error && task.last_settled.as_ref().map(|s| s.status) != Some(TurnStatus::Error))
}

/// The last settle, when it is news for this session.
fn settled_turn_attention(
    task: &AgentTaskRow,
    settled: &LastSettled,
    is_widget_round: &dyn Fn(&str) -> bool,
    last_looked: i64,
) -> Option<(AttentionKind, String, i64)> {
    // A widget round's result is in its document; the session stays quiet.
    if is_widget_round(&settled.turn_id) || settled.at <= last_looked {
        return None;
    }
    // A finished turn on a session that has since started another is not
    // news; a failure still stands.
    if settled.status == TurnStatus::Completed && is_working(task) {
        return None;
    }
    let kind = if settled.status == TurnStatus::Error { AttentionKind::Error } else { AttentionKind::Bau };
    Some((kind, settled.turn_id.clone(), settled.at))
}

fn task_attention(
    task: &AgentTaskRow,
    permission: Option<&PermissionRequestRow>,
    running_turn_id: Option<&String>,
    is_widget_round: &dyn Fn(&str) -> bool,
    rows: &AttentionRows,
) -> Option<AttentionItem> {
    let target = SeenTarget::Task(task.task_id.clone());
    let base = AttentionItem {
        target: target.clone(),
        kind: AttentionKind::Bau,
        task_id: task.task_id.clone(),
        // The turn in flight when the item was raised: what a jump prefers.
        turn_id: running_turn_id.cloned(),
        since: task.updated_at,
        workspace_key: (rows.workspace_key)(&task.workspace_path),
        ask: None,
        permission: None,
        task: Some(task.clone()),
        question: None,
    };
    // A restored session is live-but-unspawned: quiet until revived.
    if task.status == TaskStatus::Restored {
        return None;
    }
    // Asks clear when answered, not when looked at.
    if let Some(permission) = permission {
        return Some(AttentionItem {
            kind: AttentionKind::Error,
            ask: Some(AttentionAsk::Permission),
            permission: Some(permission.clone()),
            ..base
        });
    }
    if task.auth_required {
        return Some(AttentionItem { kind: AttentionKind::Error, ask: Some(AttentionAsk::Auth), ..base });
    }
    let last_looked = last_seen_at(rows.seen, &target);
    if is_error_no_turn_produced(task) {
        return (task.updated_at > last_looked).then_some(AttentionItem { kind: AttentionKind::Error, ..base });
    }
    let settled = task.last_settled.as_ref()?;
    let (kind, turn_id, since) = settled_turn_attention(task, settled, is_widget_round, last_looked)?;
    Some(AttentionItem { kind, turn_id: Some(turn_id), since, ..base })
}

fn round_attention(round: &PromptRoundRow, seen: &HashMap<String, i64>) -> Option<AttentionItem> {
    if !matches!(round.status, RecordStatus::Completed | RecordStatus::Error) {
        return None;
    }
    let settled_at = round.settled_at?;
    let target = SeenTarget::Document(round.document_path.clone());
    if settled_at <= last_seen_at(seen, &target) {
        return None;
    }
    let response = round.outcome.as_ref().and_then(|o| o.response.as_ref());
    let asks = round.status == RecordStatus::Completed && response.is_some_and(|r| r.awaits_reply());
    Some(AttentionItem {
        target,
        kind: if round.status == RecordStatus::Error || asks { AttentionKind::Error } else { AttentionKind::Bau },
        task_id: round.task_id.clone(),
        turn_id: Some(round.turn_id.clone()),
        since: settled_at,
        workspace_key: round.workspace_key.clone(),
        ask: asks.then_some(AttentionAsk::Question),
        permission: None,
        task: None,
        question: if asks { response.map(|r| r.markdown.clone()) } else { None },
    })
}

/// `deriveAttention`.
pub fn derive_attention(rows: &AttentionRows) -> Attention {
    let heads = head_permission_by_task(rows.pending_permissions);
    let running_by_task: HashMap<&String, &String> = rows.running_turns.iter().map(|(t, turn)| (t, turn)).collect();
    let round_turn_ids: HashSet<&str> = rows.rounds.iter().map(|r| r.turn_id.as_str()).collect();
    let is_widget_round = |turn_id: &str| round_turn_ids.contains(turn_id);

    let mut out = Attention::default();
    for task in rows.tasks {
        let Some(item) = task_attention(
            task,
            heads.get(&task.task_id),
            running_by_task.get(&task.task_id).copied(),
            &is_widget_round,
            rows,
        ) else {
            continue;
        };
        out.by_task.insert(task.task_id.clone(), item.kind);
        out.items.push(item);
    }
    for round in rows.rounds {
        if !rows.open_workspace_keys.contains(&round.workspace_key) {
            continue;
        }
        let Some(item) = round_attention(round, rows.seen) else { continue };
        out.by_round.insert(round.turn_id.clone(), item.kind);
        out.items.push(item);
    }
    for item in &out.items {
        out.overall = most_pressing(out.overall, Some(item.kind));
        if item.kind == AttentionKind::Error {
            *out.by_workspace.entry(item.workspace_key.clone()).or_default() += 1;
        }
    }
    // Newest first; stable, so equal moments keep row order as TS's sort.
    out.items.sort_by(|a, b| b.since.cmp(&a.since));
    out.asks = out.items.iter().filter(|i| i.ask.is_some()).cloned().collect();
    out
}
