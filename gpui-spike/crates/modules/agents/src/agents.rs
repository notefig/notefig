//! The agents facade: a port of `modules/agents/agents.ts` — `core.agents`.
//! `agents.workspace(ws).start(harness)` for a session the user starts
//! (trust gate included), `agents.task(id)` for everything after.
//!
//! Every call waits for the runtime to be up (the store hydrated and
//! reconciled, `whenReconciled`), then forwards to it.

use std::cell::RefCell;
use std::rc::Rc;

use futures::FutureExt;
use futures::future::{LocalBoxFuture, Shared};
use notefig_agent::harness::{CustomHarnessEntry, HarnessDefinition, HarnessOverride, HarnessSettingsRow};
use notefig_agent::model::{PermissionOutcome, TurnOutcome};
use notefig_agent::prompt::{PromptExtras, WidgetPromptSource};
use notefig_core::Hooks;

use crate::agent_events::{AgentOpenRequested, AgentOpenRequestedEvent};
use crate::agent_store::AgentStore;
use crate::runtime::host::AgentHandle;
use notefig_agent::harness::ResumeShellDialect;

pub use crate::runtime::host::StartResult;

/// `ActionResult`: `Ok(())` or the error the UI shows.
pub type ActionResult = Result<(), String>;

/// `PromptHandle`: the turn id now, its outcome when it settles.
pub struct PromptHandle {
    pub turn_id: String,
    pub completed: LocalBoxFuture<'static, Option<TurnOutcome>>,
}

/// What `startTask` hands back: the task id now, whether it came up later.
pub struct StartedTask {
    pub task_id: String,
    pub started: LocalBoxFuture<'static, Result<(), String>>,
}

pub(crate) struct AgentsInner {
    pub store: Rc<AgentStore>,
    pub hooks: Hooks,
    pub handle: RefCell<Option<AgentHandle>>,
    /// Workspaces trusted this run, readable at once (the runtime persists
    /// the answer to KV `agent` / `trust:<ws>` on its own thread).
    pub trusted: RefCell<std::collections::HashSet<String>>,
    pub ready: Shared<LocalBoxFuture<'static, ()>>,
}

/// `AgentsApi` — `core.agents`.
#[derive(Clone)]
pub struct AgentsApi {
    pub(crate) inner: Rc<AgentsInner>,
}

impl AgentsApi {
    pub(crate) fn new(store: Rc<AgentStore>, hooks: Hooks, ready: Shared<LocalBoxFuture<'static, ()>>) -> Self {
        Self {
            inner: Rc::new(AgentsInner {
                store,
                hooks,
                handle: RefCell::default(),
                trusted: RefCell::default(),
                ready,
            }),
        }
    }

    pub(crate) fn attach(&self, handle: AgentHandle) {
        *self.inner.handle.borrow_mut() = Some(handle);
    }

    /// The runtime handle once up.
    fn handle(&self) -> Option<AgentHandle> {
        self.inner.handle.borrow().clone()
    }

    /// Run `f` against the runtime once it is up.
    fn with<T: 'static, F>(&self, f: impl FnOnce(AgentHandle) -> F + 'static) -> LocalBoxFuture<'static, T>
    where
        F: std::future::Future<Output = T> + 'static,
    {
        let this = self.clone();
        async move {
            this.inner.ready.clone().await;
            let handle = this.handle().expect("ready means attached");
            f(handle).await
        }
        .boxed_local()
    }

    /// `whenReconciled()`: persisted rows are loaded and reconciled.
    pub fn when_reconciled(&self) -> LocalBoxFuture<'static, ()> {
        self.inner.ready.clone().boxed_local()
    }

    pub fn is_ready(&self) -> bool {
        self.inner.handle.borrow().is_some()
    }

    pub fn store(&self) -> Rc<AgentStore> {
        self.inner.store.clone()
    }

    /// `agents.task(id)`.
    pub fn task(&self, task_id: &str) -> AgentTaskHandle {
        AgentTaskHandle {
            api: self.clone(),
            task_id: task_id.to_string(),
        }
    }

    /// `agents.workspace(ws)`.
    pub fn workspace(&self, workspace_path: &str) -> AgentWorkspaceHandle {
        AgentWorkspaceHandle {
            api: self.clone(),
            workspace_path: workspace_path.to_string(),
        }
    }

    /// `disposeWorkspace`: stop its live tasks; rows with a session demote
    /// to `restored` so the next open can revive them.
    pub fn dispose_workspace(&self, workspace_path: &str) -> LocalBoxFuture<'static, ()> {
        let ws = workspace_path.to_string();
        self.with(move |h| async move {
            h.dispose_workspace(&ws).recv().await;
        })
    }

    /// `disposeAll`: every task stopped, the store flushed, every child
    /// process killed.
    pub fn dispose_all(&self) -> LocalBoxFuture<'static, ()> {
        match self.handle() {
            Some(h) => {
                let done = h.shutdown();
                async move {
                    done.recv().await;
                }
                .boxed_local()
            }
            None => futures::future::ready(()).boxed_local(),
        }
    }

    // ── harnesses (TS `core.harnesses`, folded in here; see lib.rs) ──

    /// `harnesses.ready()`: the harness rows are loaded, so a definition
    /// read now is the configured one. Install verdicts land later, as
    /// discovery finishes; `store().subscribe_harnesses` reports them.
    pub fn harnesses_ready(&self) -> LocalBoxFuture<'static, ()> {
        self.when_reconciled()
    }

    /// `harnesses.isReady()`.
    pub fn is_harnesses_ready(&self) -> bool {
        self.is_ready()
    }

    /// Harnesses a new session can use: enabled and not found missing.
    pub fn pickable_harnesses(&self) -> Vec<HarnessDefinition> {
        self.handle().map(|h| h.pickable_harnesses()).unwrap_or_default()
    }

    pub fn configured_harnesses(&self) -> Vec<HarnessDefinition> {
        self.handle().map(|h| h.configured_harnesses()).unwrap_or_default()
    }

    pub fn harness_settings(&self) -> Vec<HarnessSettingsRow> {
        self.handle().map(|h| h.harness_settings()).unwrap_or_default()
    }

    pub fn harness_label(&self, harness_id: &str) -> String {
        self.handle()
            .map(|h| h.harness_label(harness_id))
            .unwrap_or_else(|| harness_id.to_string())
    }

    /// The harness a new session in `workspace_path` uses: the one most
    /// recently used there that is still pickable, else the first pickable.
    pub fn default_harness(&self, workspace_path: &str) -> Option<String> {
        let pickable: Vec<String> = self.pickable_harnesses().into_iter().map(|h| h.id).collect();
        self.inner
            .store
            .tasks_for_workspace(workspace_path)
            .into_iter()
            .map(|t| t.harness_id)
            .find(|h| pickable.contains(h))
            .or_else(|| pickable.first().cloned())
    }

    pub fn save_override(&self, harness_id: &str, value: Option<HarnessOverride>) -> LocalBoxFuture<'static, bool> {
        let id = harness_id.to_string();
        self.with(move |h| async move { h.save_override(&id, value).recv().await.unwrap_or(false) })
    }

    pub fn save_custom(&self, harness_id: &str, entry: CustomHarnessEntry) -> LocalBoxFuture<'static, bool> {
        let id = harness_id.to_string();
        self.with(move |h| async move { h.save_custom(&id, entry).recv().await.unwrap_or(false) })
    }

    pub fn set_harness_enabled(&self, harness_id: &str, enabled: bool) {
        if let Some(h) = self.handle() {
            h.set_harness_enabled(harness_id, enabled);
        }
    }

    pub fn remove_custom_harness(&self, harness_id: &str) {
        if let Some(h) = self.handle() {
            h.remove_custom_harness(harness_id);
        }
    }

    /// Re-run install discovery (and catalog probes of what changed).
    pub fn rescan_harnesses(&self) -> LocalBoxFuture<'static, ()> {
        self.with(|h| async move {
            h.rescan_harnesses().recv().await;
        })
    }
}

/// `AgentWorkspaceHandle` — `core.workspace(ws).agents`.
#[derive(Clone)]
pub struct AgentWorkspaceHandle {
    api: AgentsApi,
    workspace_path: String,
}

impl AgentWorkspaceHandle {
    pub fn path(&self) -> &str {
        &self.workspace_path
    }

    /// Start a session the user asked for: `NeedsTrust` the first time in
    /// this workspace (confirm, `trust()`, start again).
    pub fn start(&self, harness_id: &str) -> LocalBoxFuture<'static, StartResult> {
        let (ws, id) = (self.workspace_path.clone(), harness_id.to_string());
        self.api.with(move |h| async move {
            h.start_task(&ws, &id).recv().await.unwrap_or(StartResult::UnknownHarness)
        })
    }

    /// `startTask`: start a task with no gates and no tab, for code that
    /// already holds the user's go-ahead (a widget's send). The task id
    /// comes back once the row exists; `started` settles when it can be
    /// prompted.
    pub fn start_task(&self, harness_id: &str) -> LocalBoxFuture<'static, Result<StartedTask, String>> {
        let (ws, id) = (self.workspace_path.clone(), harness_id.to_string());
        self.api.with(move |h| async move {
            let task_id = h
                .start_ungated(&ws, &id)
                .recv()
                .await
                .unwrap_or(Err("agent runtime gone".into()))?;
            let waiter = h.when_started(&task_id);
            Ok(StartedTask {
                task_id,
                started: async move { waiter.recv().await.unwrap_or(Err("agent runtime gone".into())) }
                    .boxed_local(),
            })
        })
    }

    pub fn is_trusted(&self) -> bool {
        self.api.inner.trusted.borrow().contains(&self.workspace_path)
            || self
                .api
                .handle()
                .is_some_and(|h| h.is_trusted_persisted(&self.workspace_path))
    }

    pub fn trust(&self) {
        self.api.inner.trusted.borrow_mut().insert(self.workspace_path.clone());
        if let Some(h) = self.api.handle() {
            h.trust(&self.workspace_path);
        }
    }

    /// The workspace's tasks that have a live runtime.
    pub fn live_task_ids(&self) -> Vec<String> {
        let Some(h) = self.api.handle() else { return Vec::new() };
        self.api
            .inner
            .store
            .tasks_for_workspace(&self.workspace_path)
            .into_iter()
            .filter(|t| h.is_reachable(&t.task_id))
            .map(|t| t.task_id)
            .collect()
    }
}

/// `AgentTaskHandle` — `core.agents.task(id)`.
#[derive(Clone)]
pub struct AgentTaskHandle {
    api: AgentsApi,
    task_id: String,
}

impl AgentTaskHandle {
    pub fn id(&self) -> &str {
        &self.task_id
    }

    /// Queue a prompt (FIFO). The user entry and a `queued` turn exist at once.
    pub fn prompt(&self, text: &str, extras: PromptExtras) -> LocalBoxFuture<'static, Option<PromptHandle>> {
        let (id, text) = (self.task_id.clone(), text.to_string());
        self.api.with(move |h| async move {
            let handle = h.prompt(&id, &text, extras).recv().await?;
            Some(PromptHandle {
                turn_id: handle.turn_id,
                completed: async move { handle.completed.recv().await }.boxed_local(),
            })
        })
    }

    /// A prompt from an in-document widget: framed with its passage and a
    /// widget-context resource link.
    pub fn prompt_from_widget(
        &self,
        text: &str,
        source: WidgetPromptSource,
        extras: PromptExtras,
    ) -> LocalBoxFuture<'static, Option<PromptHandle>> {
        let (id, text) = (self.task_id.clone(), text.to_string());
        self.api.with(move |h| async move {
            let handle = h.prompt_from_widget(&id, &text, source, extras).recv().await?;
            Some(PromptHandle {
                turn_id: handle.turn_id,
                completed: async move { handle.completed.recv().await }.boxed_local(),
            })
        })
    }

    pub fn remove_queued_prompt(&self, turn_id: &str) {
        if let Some(h) = self.api.handle() {
            h.remove_queued_prompt(&self.task_id, turn_id);
        }
    }

    pub fn is_reachable(&self) -> bool {
        self.api.handle().is_some_and(|h| h.is_reachable(&self.task_id))
    }

    /// Stop the running turn; queued prompts settle as cancelled.
    pub fn cancel(&self) -> LocalBoxFuture<'static, ActionResult> {
        let id = self.task_id.clone();
        self.api
            .with(move |h| async move { h.cancel(&id).recv().await.unwrap_or(Err("agent runtime gone".into())) })
    }

    /// Escape: cancel a turn nothing answered yet and forget it; true when
    /// it did (the composer gets the prompt back).
    pub fn cancel_turn_and_forget(&self) -> LocalBoxFuture<'static, bool> {
        let id = self.task_id.clone();
        self.api
            .with(move |h| async move { h.cancel_turn_and_forget(&id).recv().await.unwrap_or(false) })
    }

    /// Bring a `restored` session back (session/load replays its transcript).
    pub fn revive(&self) {
        if let Some(h) = self.api.handle() {
            h.revive(&self.task_id);
        }
    }

    pub fn refresh(&self) -> LocalBoxFuture<'static, ActionResult> {
        let id = self.task_id.clone();
        self.api
            .with(move |h| async move { h.refresh(&id).recv().await.unwrap_or(Err("agent runtime gone".into())) })
    }

    pub fn delete(&self) -> LocalBoxFuture<'static, ()> {
        let id = self.task_id.clone();
        self.api.with(move |h| async move {
            h.delete(&id).recv().await;
        })
    }

    /// Show the task's chat tab.
    pub fn open(&self) {
        let workspace_path = self.api.inner.store.task(&self.task_id).map(|t| t.workspace_path).unwrap_or_default();
        self.api.inner.hooks.emit::<AgentOpenRequested>(AgentOpenRequestedEvent {
            task_id: self.task_id.clone(),
            workspace_path,
        });
    }

    pub fn respond_permission(&self, request_id: &str, outcome: PermissionOutcome) -> LocalBoxFuture<'static, ActionResult> {
        let (id, req) = (self.task_id.clone(), request_id.to_string());
        self.api.with(move |h| async move {
            h.respond_permission(&id, &req, outcome)
                .recv()
                .await
                .unwrap_or(Err("agent runtime gone".into()))
        })
    }

    pub fn authenticate(&self, method_id: &str) -> LocalBoxFuture<'static, ActionResult> {
        let (id, method) = (self.task_id.clone(), method_id.to_string());
        self.api.with(move |h| async move {
            h.authenticate(&id, &method).recv().await.unwrap_or(Err("agent runtime gone".into()))
        })
    }

    /// "I've signed in": run the held prompt again.
    pub fn retry_after_auth(&self) -> LocalBoxFuture<'static, ActionResult> {
        let id = self.task_id.clone();
        self.api.with(move |h| async move {
            h.retry_after_auth(&id).recv().await.unwrap_or(Err("agent runtime gone".into()))
        })
    }

    pub fn set_config_option(&self, option_id: &str, value: &str) -> LocalBoxFuture<'static, ActionResult> {
        let (id, option, value) = (self.task_id.clone(), option_id.to_string(), value.to_string());
        self.api.with(move |h| async move {
            h.set_config_option(&id, &option, &value)
                .recv()
                .await
                .unwrap_or(Err("agent runtime gone".into()))
        })
    }

    /// The shell line that resumes this session in the harness's own CLI.
    pub fn resume_command(&self) -> Option<String> {
        let dialect = if cfg!(windows) { ResumeShellDialect::Powershell } else { ResumeShellDialect::Posix };
        self.api.handle()?.resume_command(&self.task_id, dialect)
    }
}
