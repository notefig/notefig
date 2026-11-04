//! The AI integration: `notefig-agent` booted inside the app.
//!
//! - [`Agents`] is the observable model: it owns the `AgentHandle`, drains
//!   `AgentEvent`s (coalesced per frame into one `notify`), keeps a version
//!   per task so views re-read only what changed, and answers the agent
//!   thread's `ClientRequest`s on the UI thread ([`services`]).
//! - [`chat`]: the chat tab; [`sessions`]: the Sessions sidebar view and the
//!   harness picker; [`widget`]: the in-document prompt widget;
//!   [`settings`]: harness and usage settings; [`glyph`]: status glyphs.

pub mod chat;
pub mod composer;
pub mod glyph;
pub mod services;
pub mod sessions;
pub mod settings;
pub mod widget;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::rc::Rc;


use gpui::{AnyWindowHandle, App, AppContext as _, Context, Entity, EventEmitter, Task, WeakEntity};
use markdown_editor::RoundId;
use notefig_agent::host::HostConfig;
use notefig_agent::mcp::RelayCommand;
use notefig_agent::{AgentEvent, AgentHandle, AgentHost, ChannelServices, ClientRequest, JsonFileStore};

use crate::app_state::AppState;
use crate::workspace_view::WorkspaceView;

pub use chat::ChatView;

/// A batch of agent events, delivered once per drain.
pub struct AgentsChanged(pub Rc<Vec<AgentEvent>>);

pub struct Agents {
    pub handle: AgentHandle,
    /// Bumped once per drained batch.
    pub version: u64,
    task_versions: HashMap<String, u64>,
    round_ids: HashMap<String, RoundId>,
    next_round: u64,
    /// Recent `Diagnostic` events (stderr, MCP traffic), newest last.
    pub diagnostics: Vec<(Option<String>, String, String)>,
    workspaces: Vec<(WeakEntity<WorkspaceView>, AnyWindowHandle)>,
    /// Each open workspace's history repo (`history_*` tools).
    pub history: crate::history::HistoryRepos,
    _tasks: Vec<Task<()>>,
}

impl EventEmitter<AgentsChanged> for Agents {}

impl Agents {
    /// Start the host with the app's defaults: a JSON store under the state
    /// dir, `ChannelServices` answered here, the app binary as MCP relay.
    pub fn boot_default(state_dir: &Path, cx: &mut App) -> Entity<Agents> {
        let (services, requests) = ChannelServices::new();
        let mut config = HostConfig::new(JsonFileStore::new(state_dir.join("agents.json")), services);
        if let Ok(exe) = std::env::current_exe() {
            config.relay = RelayCommand::app_exe(exe);
        }
        Self::start(config, requests, cx)
    }

    /// Start the host from `config` (tests pass a fake transport) and pump
    /// its events and requests on the foreground executor.
    pub fn start(
        config: HostConfig,
        requests: async_channel::Receiver<ClientRequest>,
        cx: &mut App,
    ) -> Entity<Agents> {
        let (handle, events) = AgentHost::start(config);
        let agents = cx.new(|cx: &mut Context<Agents>| {
            let pump = cx.spawn(async move |this, cx| {
                while let Ok(first) = events.recv().await {
                    let mut batch = vec![first];
                    while let Ok(more) = events.try_recv() {
                        batch.push(more);
                    }
                    if this.update(cx, |this, cx| this.apply(batch, cx)).is_err() {
                        break;
                    }
                }
            });
            let serve = cx.spawn(async move |this, cx| {
                while let Ok(request) = requests.recv().await {
                    if this
                        .update(cx, |this, cx| services::handle(this, request, cx))
                        .is_err()
                    {
                        break;
                    }
                }
            });
            Agents {
                handle,
                version: 0,
                task_versions: HashMap::new(),
                round_ids: HashMap::new(),
                next_round: 1,
                diagnostics: Vec::new(),
                workspaces: Vec::new(),
                history: Default::default(),
                _tasks: vec![pump, serve],
            }
        });
        let handle = agents.read(cx).handle.clone();
        cx.on_app_quit(move |_| {
            let done = handle.shutdown();
            async move {
                let _ = done.recv().await;
            }
        })
        .detach();
        AppState::global(cx).update(cx, |state, _| state.agent = Some(agents.clone()));
        agents
    }

    pub fn global(cx: &App) -> Option<Entity<Agents>> {
        cx.try_global::<crate::app_state::GlobalAppState>()
            .and_then(|g| g.0.read(cx).agent.clone())
    }

    fn apply(&mut self, batch: Vec<AgentEvent>, cx: &mut Context<Self>) {
        self.version += 1;
        let v = self.version;
        for event in &batch {
            let task = match event {
                AgentEvent::TaskChanged(row) => Some(row.task_id.as_str()),
                AgentEvent::TaskRemoved { task_id }
                | AgentEvent::TurnRemoved { task_id, .. }
                | AgentEvent::EntryRemoved { task_id, .. }
                | AgentEvent::TranscriptReplaced { task_id }
                | AgentEvent::ToolCall { task_id, .. }
                | AgentEvent::TurnSettled { task_id, .. }
                | AgentEvent::TurnRequeued { task_id, .. }
                | AgentEvent::Usage { task_id, .. } => Some(task_id.as_str()),
                AgentEvent::TurnChanged(turn) => Some(turn.task_id.as_str()),
                AgentEvent::EntryChanged(entry) => Some(entry.task_id.as_str()),
                AgentEvent::PermissionChanged(row) => Some(row.task_id.as_str()),
                AgentEvent::PromptRoundChanged(row) => Some(row.task_id.as_str()),
                AgentEvent::Diagnostic { task_id, label, detail } => {
                    log::debug!("agent {label}: {detail}");
                    self.diagnostics.push((task_id.clone(), label.clone(), detail.clone()));
                    if self.diagnostics.len() > 300 {
                        self.diagnostics.drain(..100);
                    }
                    None
                }
                _ => None,
            };
            if let Some(task) = task {
                self.task_versions.insert(task.to_string(), v);
            }
        }
        cx.emit(AgentsChanged(Rc::new(batch)));
        cx.notify();
    }

    /// The version at which `task_id` last changed (0 = never seen).
    pub fn task_version(&self, task_id: &str) -> u64 {
        self.task_versions.get(task_id).copied().unwrap_or(0)
    }

    /// The editor's change-tracking id for a widget round (turn).
    pub fn round_id(&mut self, turn_id: &str) -> RoundId {
        if let Some(id) = self.round_ids.get(turn_id) {
            return *id;
        }
        let id = RoundId(self.next_round);
        self.next_round += 1;
        self.round_ids.insert(turn_id.to_string(), id);
        id
    }

    pub fn turn_for_round(&self, round: RoundId) -> Option<String> {
        self.round_ids
            .iter()
            .find(|(_, r)| **r == round)
            .map(|(t, _)| t.clone())
    }

    /// Workspace views answer requests for their root.
    pub fn register_workspace(&mut self, view: WeakEntity<WorkspaceView>, window: AnyWindowHandle) {
        self.workspaces.retain(|(w, _)| w.upgrade().is_some());
        self.workspaces.push((view, window));
    }

    pub fn workspace_for(&self, root: &Path, cx: &App) -> Option<(Entity<WorkspaceView>, AnyWindowHandle)> {
        let canon = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
        self.workspaces.iter().find_map(|(w, window)| {
            let view = w.upgrade()?;
            let ws_root = view.read(cx).ws.root().to_path_buf();
            (ws_root == canon || ws_root == root).then(|| (view, *window))
        })
    }

    /// Which editor origin adopting `text` at `abs_path` is: a write the
    /// agent made (turn-write attribution) is `Agent`, with change tracking
    /// when that turn is an in-document widget round; anything else is
    /// `External`.
    pub fn origin_for(&mut self, abs_path: &Path, text: &str) -> (markdown_editor::EditOrigin, Option<RoundId>) {
        let hash = notefig_agent::rounds::content_hash(text);
        let Some(writer) = self.handle.attribute_write(&abs_path.to_string_lossy(), &hash) else {
            return (markdown_editor::EditOrigin::External, None);
        };
        let is_round = self
            .handle
            .prompt_rounds()
            .iter()
            .any(|r| r.turn_id == writer.turn_id);
        if is_round {
            let round = self.round_id(&writer.turn_id);
            (markdown_editor::EditOrigin::Agent { round: Some(round) }, Some(round))
        } else {
            (markdown_editor::EditOrigin::Agent { round: None }, None)
        }
    }

    /// The harness a new session uses: the one most recently used in this
    /// workspace that is still pickable, else the first pickable.
    pub fn default_harness(&self, workspace: &str) -> Option<String> {
        let pickable: Vec<String> = self.handle.pickable_harnesses().into_iter().map(|h| h.id).collect();
        let mut tasks = self.handle.tasks_for_workspace(workspace);
        tasks.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        tasks
            .into_iter()
            .map(|t| t.harness_id)
            .find(|h| pickable.contains(h))
            .or_else(|| pickable.first().cloned())
    }

    pub fn state_dir(cx: &App) -> PathBuf {
        let _ = cx;
        notefig_workspace::StateStore::default_dir().unwrap_or_else(std::env::temp_dir)
    }
}

/// Which editor origin adopting `text` at `abs_path` is (see
/// [`Agents::origin_for`]).
pub fn origin_for_write(
    agents: &Entity<Agents>,
    abs_path: &Path,
    text: &str,
    cx: &mut App,
) -> (markdown_editor::EditOrigin, Option<RoundId>) {
    agents.update(cx, |a, _| a.origin_for(abs_path, text))
}

/// Short relative time ("now", "5m", "3h", "2d").
pub fn ago(ms: i64) -> String {
    let now = notefig_workspace::state::now_ms() as i64;
    let s = ((now - ms).max(0)) / 1000;
    match s {
        0..=59 => "now".into(),
        60..=3599 => format!("{}m", s / 60),
        3600..=86399 => format!("{}h", s / 3600),
        _ => format!("{}d", s / 86400),
    }
}

