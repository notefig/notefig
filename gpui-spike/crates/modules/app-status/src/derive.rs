//! `deriveAppStatus` (`hooks/use-app-status.ts`): the status for outside the
//! window as a pure function of what the sidebar shows. The inputs are
//! plain rows, so whoever gathers them (the shell, from the agents,
//! prompt-rounds, recent-documents and seen modules) needs no React-shaped
//! hooks; what picking an entry does goes through [`AppStatusHost`].

use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use crate::model::{AppStatus, AppStatusAction, AppStatusActivate, AppStatusEntry, AppStatusSection};

/// Rows per section: a glance, not the sidebar.
pub const APP_STATUS_ROWS: usize = 3;
/// A prompt's first line can run long; the menu should not.
pub const LABEL_CHARS: usize = 48;

/// `AttentionKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttentionKind {
    Bau,
    Error,
}

/// `attentionGlyphState`.
pub fn attention_mark(kind: AttentionKind) -> &'static str {
    match kind {
        AttentionKind::Bau => "attention-bau",
        AttentionKind::Error => "attention-error",
    }
}

/// `turnGlyphState`: a turn's (round's) status → mark.
pub fn turn_mark(status: &str) -> &'static str {
    match status {
        "running" => "running",
        "queued" => "queued",
        "completed" => "done",
        "cancelled" => "cancelled",
        _ => "error",
    }
}

/// `taskGlyphState`: sign-in blocks everything else, then the status.
pub fn task_mark(status: &str, auth_required: bool) -> &'static str {
    if auth_required {
        return "auth";
    }
    match status {
        "starting" => "starting",
        "running" => "running",
        // A restored session is an idle one whose runtime revives on use.
        "idle" | "restored" => "idle",
        "cancelled" => "cancelled",
        "unavailable" => "unavailable",
        _ => "error",
    }
}

/// One prompt round (`PromptRound`), live first.
#[derive(Debug, Clone, PartialEq)]
pub struct RoundRow {
    pub turn_id: String,
    pub task_id: String,
    pub document_path: String,
    pub prompt: String,
    /// `AgentTurnStatus`: running | queued | completed | cancelled | error.
    pub status: String,
}

impl RoundRow {
    /// `isLiveRound`.
    pub fn is_live(&self) -> bool {
        self.status == "running" || self.status == "queued"
    }

    /// `describePromptRound`'s i18n key, or None once completed.
    pub fn meta_key(&self) -> Option<&'static str> {
        match self.status.as_str() {
            "running" => Some("agentRunning"),
            "queued" => Some("roundQueued"),
            "cancelled" => Some("roundCancelled"),
            "error" => Some("agentFailed"),
            _ => None,
        }
    }
}

/// One session (`AgentTaskMeta`).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct SessionRow {
    pub task_id: String,
    pub workspace_path: String,
    pub title: String,
    pub status: String,
    pub auth_required: bool,
    pub queued_count: u32,
    pub is_running: bool,
    pub needs_auth: bool,
    pub is_error: bool,
    pub is_unavailable: bool,
}

/// `describeTaskMeta`: the i18n key and its count argument, if any.
pub fn describe_task_meta(meta: &SessionRow, t: &dyn Fn(&str, Option<u32>) -> String) -> Option<String> {
    if meta.needs_auth {
        return Some(t("agentNeedsSignIn", None));
    }
    if meta.is_running {
        return Some(if meta.queued_count > 0 {
            t("agentRunningQueued", Some(meta.queued_count))
        } else {
            t("agentRunning", None)
        });
    }
    if meta.queued_count > 0 {
        return Some(t("agentQueuedCount", Some(meta.queued_count)));
    }
    if meta.is_error {
        return Some(t("agentFailed", None));
    }
    if meta.is_unavailable {
        return Some(t("agentSessionUnavailable", None));
    }
    None
}

/// One recent document.
#[derive(Debug, Clone, PartialEq)]
pub struct DocumentRow {
    pub path: String,
    pub workspace_path: String,
}

/// What an attention item points at (`SeenTarget`).
#[derive(Debug, Clone, PartialEq)]
pub enum AttentionTarget {
    Document(String),
    Task(String),
}

/// `AttentionItem`, the parts the menu reads.
#[derive(Debug, Clone, PartialEq)]
pub struct AttentionItem {
    pub target: AttentionTarget,
    pub kind: AttentionKind,
    pub task_id: String,
    pub turn_id: Option<String>,
    pub workspace_key: String,
    /// The task's title, if its row is known.
    pub task_title: Option<String>,
}

/// `Pick<Attention, "items" | "overall" | "byRound" | "byTask">`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Attention {
    pub items: Vec<AttentionItem>,
    pub overall: Option<AttentionKind>,
    pub by_round: HashMap<String, AttentionKind>,
    pub by_task: HashMap<String, AttentionKind>,
}

/// What picking a row or action does — the app's behaviour, not the
/// platform's (`AppStatusHost` + the `Jumper`).
pub trait AppStatusHost {
    /// Whether there are tabs to open an entry into (false on welcome).
    fn has_tabs(&self) -> bool;
    /// Whether the focused workspace can take a new scratchpad.
    fn has_scratchpads(&self) -> bool;
    fn open_document(&self, path: &str);
    fn open_agent(&self, task_id: &str);
    /// `jumpToRound`.
    fn jump_to_round(&self, task_id: &str, turn_id: &str, document_path: &str);
    /// `jumpToTask`.
    fn jump_to_task(&self, task_id: &str, turn_id: Option<&str>);
    fn new_scratchpad(&self);
    fn open_workspace(&self);
    fn open_settings(&self);
}

pub struct AppStatusInputs {
    pub host: Rc<dyn AppStatusHost>,
    /// Every round, live first.
    pub rounds: Vec<RoundRow>,
    /// The newest sessions (at most [`APP_STATUS_ROWS`]).
    pub sessions: Vec<SessionRow>,
    /// The newest documents (at most [`APP_STATUS_ROWS`]).
    pub documents: Vec<DocumentRow>,
    pub attention: Attention,
    /// `t(key)`, with a count for the pluralized keys.
    pub t: Rc<dyn Fn(&str, Option<u32>) -> String>,
}

fn clip(label: &str) -> String {
    if label.chars().count() > LABEL_CHARS {
        let mut out: String = label.chars().take(LABEL_CHARS - 1).collect();
        out.push('…');
        out
    } else {
        label.to_string()
    }
}

fn file_name(path: &str) -> String {
    path.rsplit(['/', '\\']).find(|s| !s.is_empty()).unwrap_or(path).to_string()
}

/// `deriveProjectName`.
pub fn project_name(path: &str) -> String {
    path.split(['/', '\\']).filter(|s| !s.is_empty()).next_back().unwrap_or("Untitled").to_string()
}

struct Builder;

impl Builder {
    fn entry(
        &mut self,
        id: String,
        label: String,
        detail: Option<String>,
        mark: &str,
        activate: impl Fn() + 'static,
    ) -> AppStatusEntry {
        AppStatusEntry { id, label, detail, mark: Some(mark.to_string()), activate: AppStatusActivate::new(activate) }
    }
}

fn listed_id_of(item: &AttentionItem) -> String {
    match item.target {
        AttentionTarget::Document(_) => format!("prompts:{}", item.turn_id.clone().unwrap_or_default()),
        AttentionTarget::Task(_) => format!("sessions:{}", item.task_id),
    }
}

/// `deriveAppStatus`.
pub fn derive_app_status(inputs: &AppStatusInputs) -> AppStatus {
    let host = inputs.host.clone();
    let t = inputs.t.clone();
    let tr = |key: &str| t(key, None);
    let attention = &inputs.attention;
    let mut b = Builder;
    let has_tabs = host.has_tabs();

    let mut sections = Vec::new();
    if has_tabs {
        let live_documents: HashSet<&str> =
            inputs.rounds.iter().filter(|r| r.is_live()).map(|r| r.document_path.as_str()).collect();

        let prompts = inputs
            .rounds
            .iter()
            .take(APP_STATUS_ROWS)
            .map(|round| {
                let mark = attention
                    .by_round
                    .get(&round.turn_id)
                    .map(|k| attention_mark(*k))
                    .unwrap_or_else(|| turn_mark(&round.status));
                let label = if round.prompt.is_empty() { file_name(&round.document_path) } else { round.prompt.clone() };
                // A completed round names where its result is: a relative
                // time would sit stale in a menu that only redraws on change.
                let detail = round.meta_key().map(&tr).unwrap_or_else(|| file_name(&round.document_path));
                let (host, r) = (host.clone(), round.clone());
                b.entry(format!("prompts:{}", round.turn_id), clip(&label), Some(detail), mark, move || {
                    host.jump_to_round(&r.task_id, &r.turn_id, &r.document_path)
                })
            })
            .collect::<Vec<_>>();

        let documents = inputs
            .documents
            .iter()
            .map(|doc| {
                let mark = if live_documents.contains(doc.path.as_str()) { "running" } else { "document" };
                let (host, path) = (host.clone(), doc.path.clone());
                b.entry(
                    format!("documents:{}", doc.path),
                    clip(&file_name(&doc.path)),
                    Some(project_name(&doc.workspace_path)),
                    mark,
                    move || host.open_document(&path),
                )
            })
            .collect::<Vec<_>>();

        let sessions = inputs
            .sessions
            .iter()
            .map(|meta| {
                let mark = attention
                    .by_task
                    .get(&meta.task_id)
                    .map(|k| attention_mark(*k))
                    .unwrap_or_else(|| task_mark(&meta.status, meta.auth_required));
                // A settled session names its project.
                let detail = describe_task_meta(meta, &*t).unwrap_or_else(|| project_name(&meta.workspace_path));
                let (host, task) = (host.clone(), meta.task_id.clone());
                b.entry(format!("sessions:{}", meta.task_id), clip(&meta.title), Some(detail), mark, move || {
                    host.open_agent(&task)
                })
            })
            .collect::<Vec<_>>();

        let all = [
            ("prompts", tr("promptRounds"), prompts),
            ("documents", tr("recentDocuments"), documents),
            ("sessions", tr("agentSessions"), sessions),
        ];
        let listed: HashSet<String> = all.iter().flat_map(|(_, _, e)| e.iter().map(|e| e.id.clone())).collect();
        // What the recency cut leaves out still lights the dot, so it gets a
        // row: uncapped, every item that lights the dot has one.
        let attention_entries = attention
            .items
            .iter()
            .filter(|item| !listed.contains(&listed_id_of(item)))
            .map(|item| {
                let label = match &item.target {
                    AttentionTarget::Document(path) => file_name(path),
                    AttentionTarget::Task(_) => item.task_title.clone().unwrap_or_else(|| item.task_id.clone()),
                };
                let (host, item_c) = (host.clone(), item.clone());
                b.entry(
                    format!("attention:{}:{}", item.task_id, item.turn_id.clone().unwrap_or_else(|| "null".into())),
                    clip(&label),
                    Some(project_name(&item.workspace_key)),
                    attention_mark(item.kind),
                    move || match (&item_c.target, &item_c.turn_id) {
                        (AttentionTarget::Document(path), Some(turn)) => {
                            host.jump_to_round(&item_c.task_id, turn, path)
                        }
                        _ => host.jump_to_task(&item_c.task_id, item_c.turn_id.as_deref()),
                    },
                )
            })
            .collect::<Vec<_>>();
        sections.push(AppStatusSection { id: "attention".into(), title: tr("needsAttention"), entries: attention_entries });
        for (id, title, entries) in all {
            sections.push(AppStatusSection { id: id.into(), title, entries });
        }
        sections.retain(|s| !s.entries.is_empty());
    }

    let mut actions = Vec::new();
    let mut action = |id: &str, label: String, activate: AppStatusActivate| {
        actions.push(AppStatusAction { id: id.into(), label, activate });
    };
    let h = host.clone();
    action("open-workspace", tr("openProject"), AppStatusActivate::new(move || h.open_workspace()));
    if host.has_scratchpads() && has_tabs {
        let h = host.clone();
        action("new-scratchpad", tr("newScratchpad"), AppStatusActivate::new(move || h.new_scratchpad()));
    }
    let h = host.clone();
    action("settings", tr("settings"), AppStatusActivate::new(move || h.open_settings()));

    // No tabs (welcome), no rows — and no dot, which would point at nothing.
    let overall = if has_tabs { attention.overall } else { None };
    AppStatus { attention: overall.map(|k| attention_mark(k).to_string()), sections, actions }
}
