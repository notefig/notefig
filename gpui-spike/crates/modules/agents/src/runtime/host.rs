//! The host: a dedicated thread running a single-threaded smol executor
//! that owns every live task. The app drives it through [`AgentHandle`]
//! (commands are closures run on the agent thread; replies come back as
//! [`Pending`]) and renders from the [`AgentEvent`] receiver + snapshot
//! reads of the shared [`AgentState`].

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde_json::{Value, json};

use notefig_agent::acp::{AcpClient, AcpDelegate};
use crate::runtime::events::AgentEvent;
use notefig_harness_adapters::{CatalogDiscovery, InvokeContext, UsageReporting, adapter_for};
use notefig_agent::harness::*;
use notefig_agent::harness::discovery::{ProbeEntry, discover_harnesses};
use notefig_agent::ids::now_ms;
use notefig_agent::mcp::RelayCommand;
use notefig_agent::model::*;
use notefig_agent::process::{
    ProcessTransport, SpawnSpec, TransportFactory, run_shell_command, with_timeout,
};
use notefig_agent::prompt::{PromptExtras, WidgetPromptSource, widget_prompt};
use notefig_agent::rpc::{LocalBoxFuture, Spawner};
use notefig_agent::services::ClientServices;
use crate::runtime::store::{AgentState, Db, Store, StoredLimits};
use crate::runtime::task::Task;
use notefig_agent::usage::{UsageBucket, merge_limits, record_bucket};

pub const STARTUP_STEP_TIMEOUT: Duration = Duration::from_secs(60);
const PROBE_SETTLE: Duration = Duration::from_secs(2);
const PROBE_STEP_TIMEOUT: Duration = Duration::from_secs(10);
const PROBE_REFRESH_MS: i64 = 24 * 60 * 60 * 1000;
const PROBE_CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);
const PROBE_FAILED_BACKOFF_MS: i64 = 10 * 60 * 1000;
const FLUSH_EVERY: Duration = Duration::from_millis(250);

/// How the host is built.
pub struct HostConfig {
    pub store: Box<dyn Store>,
    pub services: Arc<dyn ClientServices>,
    /// What the harness runs for the app's MCP server.
    pub relay: RelayCommand,
    /// Run the one-batch login-shell install probe at boot.
    pub discover_on_boot: bool,
    /// Keep each found harness's catalog (models/settings/commands) probed:
    /// at boot and every 6 hours when stale (>1 day or its command/args/env
    /// changed), and again whenever its harness row is edited or rescanned.
    pub probe_catalogs: bool,
    /// Deadline for each startup step (initialize, session/new, session/load).
    pub startup_timeout: Duration,
    /// A directory that is no workspace, for catalog probe sessions.
    pub probe_dir: PathBuf,
    /// How agent byte streams are opened (default: spawn a child process).
    pub transport: Arc<dyn TransportFactory>,
}

impl HostConfig {
    pub fn new(store: impl Store, services: Arc<dyn ClientServices>) -> HostConfig {
        HostConfig {
            store: Box::new(store),
            services,
            relay: RelayCommand::discover(),
            discover_on_boot: true,
            probe_catalogs: true,
            startup_timeout: STARTUP_STEP_TIMEOUT,
            probe_dir: std::env::temp_dir().join("notefig-harness-probe"),
            transport: Arc::new(ProcessTransport),
        }
    }
}

/// A reply that arrives later. `recv().await` from any executor, or
/// `recv_blocking()` off the UI thread.
pub struct Pending<T>(async_channel::Receiver<T>);

impl<T> Pending<T> {
    pub async fn recv(self) -> Option<T> {
        self.0.recv().await.ok()
    }
    pub fn recv_blocking(self) -> Option<T> {
        self.0.recv_blocking().ok()
    }
    pub fn try_recv(&self) -> Option<T> {
        self.0.try_recv().ok()
    }
}

fn pending<T>() -> (async_channel::Sender<T>, Pending<T>) {
    let (tx, rx) = async_channel::bounded(1);
    (tx, Pending(rx))
}

/// What `start_task` answers.
#[derive(Debug, Clone, PartialEq)]
pub enum StartResult {
    /// The row exists (status `starting`); the session comes up async.
    Started {
        task_id: String,
    },
    /// First session in this workspace: confirm, `trust()`, retry.
    NeedsTrust,
    UnknownHarness,
}

/// A prompt's handle: its turn id now, its outcome when it settles.
pub struct PromptHandle {
    pub turn_id: String,
    pub completed: Pending<TurnOutcome>,
}

/// What tasks reach: storage, executor, the app's services.
pub(crate) struct Shared {
    pub spawner: Spawner,
    pub db: Db,
    pub services: Arc<dyn ClientServices>,
    pub relay: RelayCommand,
    pub startup_timeout: Duration,
    pub transport: Arc<dyn TransportFactory>,
}

impl Shared {
    /// A hook moment: the in-crate listeners (usage buckets, limits,
    /// harness catalog) run, then the app hears it. Prompt rounds, turn
    /// writes and shared sessions are their own modules
    /// (`notefig-prompt-rounds`, `notefig-turn-writes`,
    /// `notefig-shared-sessions`), listening on core's hooks.
    pub fn announce(&self, event: AgentEvent) {
        match &event {
            AgentEvent::Usage {
                at,
                harness_id,
                workspace_path,
                usage,
                ..
            } => {
                record_bucket(
                    &mut self.db.lock().usage_buckets,
                    *at,
                    harness_id,
                    workspace_path,
                    usage,
                );
                self.db.mark_dirty();
            }
            AgentEvent::UsageLimits {
                harness_id,
                at,
                limits,
                ..
            } => {
                {
                    let mut state = self.db.lock();
                    let merged = merge_limits(
                        state.usage_limits.get(harness_id).map(|s| &s.limits),
                        limits,
                    );
                    state.usage_limits.insert(
                        harness_id.clone(),
                        StoredLimits {
                            harness_id: harness_id.clone(),
                            at: *at,
                            limits: merged,
                        },
                    );
                }
                self.db.mark_dirty();
            }
            AgentEvent::Catalog {
                harness_id,
                config_options,
                ..
            } => {
                // A session's commands may be workspace skills: only settings go on the harness row.
                if config_options.is_some() {
                    record_offer(
                        &self.db,
                        harness_id,
                        HarnessCatalog {
                            config_options: config_options.clone(),
                            commands: None,
                        },
                    );
                }
            }
            _ => {}
        }
        self.db.emit(event);
    }
}

/// Keep what a harness offers: each non-empty list replaces the kept one.
fn record_offer(db: &Db, harness_id: &str, offer: HarnessCatalog) {
    let known = harness_definition(&db.lock().harnesses, harness_id).is_some();
    let config = offer.config_options.filter(|o| !o.is_empty());
    let commands = offer.commands.filter(|c| !c.is_empty());
    if !known || (config.is_none() && commands.is_none()) {
        return;
    }
    db.upsert_harness(harness_id, |row| {
        let kept = row.catalog.take().unwrap_or_default();
        row.catalog = Some(HarnessCatalog {
            config_options: config.or(kept.config_options),
            commands: commands.or(kept.commands),
        });
    });
}

pub(crate) struct Runtime {
    sh: Rc<Shared>,
    tasks: RefCell<HashMap<String, Rc<Task>>>,
    trusted_this_run: RefCell<HashSet<String>>,
    probe_dir: PathBuf,
    probe: RefCell<ProbeQueue>,
    probe_catalogs: bool,
}

type Command = Box<dyn FnOnce(&Rc<Runtime>) + Send>;

fn trust_key(workspace: &str) -> String {
    format!("agent/trust:{workspace}")
}

impl Runtime {
    fn spawn<F: std::future::Future<Output = ()> + 'static>(&self, fut: F) {
        self.sh.spawner.spawn(fut).detach();
    }

    fn definition(&self, harness_id: &str) -> Option<HarnessDefinition> {
        harness_definition(&self.sh.db.lock().harnesses, harness_id)
    }

    fn is_trusted(&self, workspace: &str) -> bool {
        self.trusted_this_run.borrow().contains(workspace)
            || self.sh.db.kv_get(&trust_key(workspace)) == Some(Value::Bool(true))
    }

    /// Create + start a task (no trust gate).
    fn start_task(&self, workspace: &str, harness: HarnessDefinition) -> Rc<Task> {
        let task = Task::new(
            self.sh.clone(),
            notefig_agent::ids::new_task_id(),
            workspace.to_string(),
            harness,
            None,
        );
        self.tasks
            .borrow_mut()
            .insert(task.id.clone(), task.clone());
        let t = task.clone();
        // start() inserts the row synchronously before its first await.
        let fut = t.start(None);
        self.spawn(async move {
            let _ = fut.await;
        });
        task
    }

    /// Revive a restored row under its original id (session/load).
    fn revive(&self, task_id: &str) -> Option<Rc<Task>> {
        if self.tasks.borrow().contains_key(task_id) {
            return None;
        }
        let row = self.sh.db.task(task_id)?;
        if row.status != TaskStatus::Restored {
            return None;
        }
        let session_id = row.session_id.clone()?;
        let Some(harness) = self.definition(&row.harness_id) else {
            self.sh.db.update_task(task_id, |r| {
                r.status = TaskStatus::Unavailable;
                r.updated_at = now_ms();
            });
            return None;
        };
        let task = Task::new(
            self.sh.clone(),
            task_id.to_string(),
            row.workspace_path.clone(),
            harness,
            row.parent_task_id.clone(),
        );
        self.tasks
            .borrow_mut()
            .insert(task_id.to_string(), task.clone());
        let fut = task.clone().start(Some(session_id));
        self.spawn(async move {
            let _ = fut.await;
        });
        Some(task)
    }

    fn get_or_revive(&self, task_id: &str) -> Option<Rc<Task>> {
        if let Some(task) = self.tasks.borrow().get(task_id) {
            return Some(task.clone());
        }
        self.revive(task_id)
    }

    fn live(&self, task_id: &str) -> Option<Rc<Task>> {
        self.tasks.borrow().get(task_id).cloned()
    }

    fn dispose_task(&self, task_id: &str) {
        let task = self.tasks.borrow_mut().remove(task_id);
        if let Some(task) = task {
            task.dispose();
        }
    }

    fn dispose_workspace(&self, workspace: &str) {
        let ids: Vec<String> = self
            .tasks
            .borrow()
            .values()
            .filter(|t| t.workspace == workspace)
            .map(|t| t.id.clone())
            .collect();
        for id in ids {
            self.dispose_task(&id);
        }
        let rows: Vec<AgentTaskRow> = self
            .sh
            .db
            .lock()
            .tasks
            .values()
            .filter(|r| r.workspace_path == workspace)
            .cloned()
            .collect();
        for row in rows {
            if row.session_id.is_some() {
                self.sh.db.update_task(&row.task_id, |r| {
                    r.status = TaskStatus::Restored;
                    r.auth_required = false;
                });
            } else {
                self.sh.db.purge_task(&row.task_id);
            }
        }
    }

    fn dispose_all(&self) {
        let workspaces: HashSet<String> = self
            .tasks
            .borrow()
            .values()
            .map(|t| t.workspace.clone())
            .collect();
        for ws in workspaces {
            self.dispose_workspace(&ws);
        }
    }

    // ── harnesses ──

    async fn rescan(
        self: Rc<Self>,
        ids: Option<Vec<String>>,
    ) -> Option<Vec<HarnessDiscoveryResult>> {
        let entries: Vec<ProbeEntry> = {
            let state = self.sh.db.lock();
            let rows = harness_settings_rows(&state.harnesses);
            rows.into_iter()
                .filter(|r| match &ids {
                    Some(ids) => ids.contains(&r.definition.id),
                    None => r.origin != HarnessOrigin::Custom || r.enabled,
                })
                .map(|r| ProbeEntry {
                    id: r.definition.id.clone(),
                    command: r.definition.command.clone(),
                    probe_command: r.definition.probe_command.clone(),
                })
                .collect()
        };
        let results = discover_harnesses(&entries).await?;
        for result in &results {
            let r = result.clone();
            self.sh
                .db
                .upsert_harness(&result.harness_id, |row| row.install = Some(r));
        }
        // An edited (or newly found) harness gets its catalog re-probed;
        // staleness decides whether anything actually runs.
        if self.probe_catalogs && ids.is_some() {
            let _ = self.check_catalogs(results.iter().map(|r| r.harness_id.clone()).collect(), false);
        }
        Some(results)
    }

    /// Queue harnesses for a catalog probe (`harness-probe.ts` policy): one
    /// at a time; skipped unless found, probeable and stale (never probed,
    /// command/args/env edited, or >1 day old) — `force` ignores staleness;
    /// a failure backs off 10 minutes for the same definition. Resolves
    /// when the queue has drained.
    fn check_catalogs(self: &Rc<Self>, ids: Vec<String>, force: bool) -> async_channel::Receiver<()> {
        let (tx, rx) = async_channel::bounded(1);
        let start = {
            let mut probe = self.probe.borrow_mut();
            for id in ids {
                if !probe.pending.contains(&id) {
                    probe.pending.push(id.clone());
                }
                if force {
                    probe.forced.insert(id);
                }
            }
            probe.waiters.push(tx);
            !std::mem::replace(&mut probe.draining, true)
        };
        if start {
            let me = self.clone();
            self.spawn(async move { me.drain_probes().await });
        }
        rx
    }

    /// Every configured harness (boot, the 6-hour check).
    fn check_all_catalogs(self: &Rc<Self>) -> async_channel::Receiver<()> {
        let ids = configured_harnesses(self.sh.db.lock().harnesses.values())
            .into_iter()
            .map(|h| h.id)
            .collect();
        self.check_catalogs(ids, false)
    }

    fn probeable(&self, harness_id: &str) -> Option<HarnessDefinition> {
        let state = self.sh.db.lock();
        let definition = configured_harnesses(state.harnesses.values())
            .into_iter()
            .find(|h| h.id == harness_id)?;
        if matches!(adapter_for(&definition).catalog_discovery(), CatalogDiscovery::None) {
            return None;
        }
        let found = state
            .harnesses
            .get(harness_id)
            .and_then(|r| r.install.as_ref())
            .is_some_and(|i| i.found);
        found.then_some(definition)
    }

    async fn drain_probes(self: Rc<Self>) {
        loop {
            let next = {
                let mut probe = self.probe.borrow_mut();
                if probe.pending.is_empty() {
                    None
                } else {
                    let id = probe.pending.remove(0);
                    let force = probe.forced.remove(&id);
                    Some((id, force))
                }
            };
            let Some((id, force)) = next else { break };
            self.clone().probe_one(&id, force).await;
        }
        let waiters = {
            let mut probe = self.probe.borrow_mut();
            probe.draining = false;
            std::mem::take(&mut probe.waiters)
        };
        for w in waiters {
            let _ = w.try_send(());
        }
    }

    async fn probe_one(self: Rc<Self>, harness_id: &str, force: bool) {
        let Some(harness) = self.probeable(harness_id) else { return };
        let shape = probed_as(&harness);
        let now = now_ms();
        if !force {
            let backing_off = self
                .probe
                .borrow()
                .failed
                .get(harness_id)
                .is_some_and(|(a, at)| *a == shape && now - at < PROBE_FAILED_BACKOFF_MS);
            let key = format!("harness-probe/{harness_id}");
            let fresh = self.sh.db.kv_get(&key).is_some_and(|last| {
                last.get("as").and_then(Value::as_str) == Some(shape.as_str())
                    && now - last.get("at").and_then(Value::as_i64).unwrap_or(0) < PROBE_REFRESH_MS
            });
            if backing_off || fresh {
                return;
            }
        }
        let found = probe_catalog(&self.sh.spawner, &self.sh.transport, &harness, &self.probe_dir).await;
        let useful = found.as_ref().is_some_and(|f| {
            f.config_options.as_ref().is_some_and(|o| !o.is_empty())
                || f.commands.as_ref().is_some_and(|c| !c.is_empty())
        });
        if !useful {
            self.probe
                .borrow_mut()
                .failed
                .insert(harness_id.to_string(), (shape.clone(), now_ms()));
            self.sh.db.emit(AgentEvent::Diagnostic {
                task_id: None,
                label: "catalog probe found nothing".into(),
                detail: harness_id.into(),
            });
            return;
        }
        self.probe.borrow_mut().failed.remove(harness_id);
        // Edited while probing: what was found describes the old definition.
        if self.probeable(harness_id).map(|h| probed_as(&h)) != Some(shape.clone()) {
            return;
        }
        record_offer(&self.sh.db, harness_id, found.unwrap());
        self.sh.db.kv_set(
            &format!("harness-probe/{harness_id}"),
            json!({"as": shape, "at": now_ms()}),
        );
    }
}

/// What a probe result is valid for: the spawn shape.
fn probed_as(h: &HarnessDefinition) -> String {
    json!([h.command, h.args, h.env]).to_string()
}

#[derive(Default)]
struct ProbeQueue {
    pending: Vec<String>,
    forced: HashSet<String>,
    draining: bool,
    waiters: Vec<async_channel::Sender<()>>,
    /// id → (probed-as, at) of the last failure.
    failed: HashMap<String, (String, i64)>,
}

// ── catalog probe ───────────────────────────────────────────────────────

#[derive(Default)]
struct ProbeDelegate {
    commands: RefCell<Option<Vec<AvailableCommand>>>,
    config: RefCell<Option<Vec<SessionConfigSelect>>>,
}

impl AcpDelegate for ProbeDelegate {
    fn session_update(&self, params: &Value) {
        let update = &params["update"];
        if update.get("sessionUpdate").and_then(Value::as_str) == Some("available_commands_update")
        {
            let commands = update
                .get("availableCommands")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(|c| serde_json::from_value(c.clone()).ok())
                        .collect()
                });
            *self.commands.borrow_mut() = commands;
        }
    }
    fn config_changed(&self, _session_id: &str, options: &[SessionConfigSelect]) {
        *self.config.borrow_mut() = Some(options.to_vec());
    }
    fn request_permission(&self, _params: Value) -> LocalBoxFuture<Value> {
        Box::pin(async { PermissionOutcome::Cancelled.to_json() })
    }
    fn read_text_file(
        &self,
        _p: String,
        _l: Option<u64>,
        _n: Option<u64>,
    ) -> LocalBoxFuture<Result<String, String>> {
        Box::pin(async { Err("no files in a probe".to_string()) })
    }
    fn write_text_file(&self, _p: String, _c: String) -> LocalBoxFuture<Result<(), String>> {
        Box::pin(async { Err("no files in a probe".to_string()) })
    }
}

fn harness_command_line(harness: &HarnessDefinition, args: &[String]) -> String {
    let mut parts: Vec<String> = harness
        .env
        .iter()
        .filter(|(k, _)| {
            !k.is_empty()
                && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
                && !k.starts_with(|c: char| c.is_ascii_digit())
        })
        .map(|(k, v)| format!("{k}={}", shell_quote(v)))
        .collect();
    parts.push(shell_quote(&harness.command));
    parts.extend(args.iter().map(|a| shell_quote(a)));
    parts.join(" ")
}

/// Find a harness's catalog before any user session.
pub(crate) async fn probe_catalog(
    spawner: &Spawner,
    transport: &Arc<dyn TransportFactory>,
    harness: &HarnessDefinition,
    dir: &std::path::Path,
) -> Option<HarnessCatalog> {
    let adapter = adapter_for(harness);
    match adapter.catalog_discovery() {
        CatalogDiscovery::None => None,
        CatalogDiscovery::ByCommand { args, parse } => {
            let out = run_shell_command(&harness_command_line(harness, &args))
                .await
                .ok()?;
            if out.exit_code != Some(0) {
                return None;
            }
            parse(&out.stdout)
        }
        CatalogDiscovery::BySession => {
            std::fs::create_dir_all(dir).ok()?;
            let refuse =
                |_: &std::path::Path, _: &str| Err::<(), String>("no files in a probe".into());
            let prep = adapter.on_invoke(&InvokeContext {
                workspace_path: dir,
                harness_env: &harness.env,
                mcp_server: None,
                write_file: &refuse,
                warn: &|_, _| {},
            });
            let (args, _) = resolve_harness_spawn(harness, &dir.to_string_lossy());
            let mut env = harness.env.clone();
            env.extend(prep.env.clone());
            let process = with_timeout(
                PROBE_STEP_TIMEOUT,
                transport.open(SpawnSpec {
                    harness_id: harness.id.clone(),
                    task_id: String::new(),
                    program: harness.command.clone(),
                    args,
                    cwd: dir.into(),
                    env,
                }),
            )
            .await?
            .ok()?;
            let delegate = Rc::new(ProbeDelegate::default());
            let client = AcpClient::new(
                spawner,
                process.reader,
                process.writer,
                delegate.clone(),
                false,
                || {},
            );
            let guard = process.guard;
            let result = async {
                with_timeout(
                    PROBE_STEP_TIMEOUT,
                    client.connect(true, adapter.client_meta()),
                )
                .await?
                .ok()?;
                let session_id = with_timeout(
                    PROBE_STEP_TIMEOUT,
                    client.new_session(&dir.to_string_lossy(), vec![], &prep.session_params),
                )
                .await?
                .ok()?;
                smol::Timer::after(PROBE_SETTLE).await;
                let _ = with_timeout(PROBE_STEP_TIMEOUT, async {
                    match client.delete_session(&session_id).await {
                        Ok(true) => {}
                        _ => {
                            let _ = client.close_session(&session_id).await;
                        }
                    }
                })
                .await;
                Some(HarnessCatalog {
                    config_options: delegate.config.borrow().clone(),
                    commands: delegate.commands.borrow().clone(),
                })
            }
            .await;
            client.close();
            drop(guard);
            result
        }
    }
}

// ── host + handle ───────────────────────────────────────────────────────

/// Starts the agent thread.
pub struct AgentHost;

impl AgentHost {
    pub fn start(config: HostConfig) -> (AgentHandle, async_channel::Receiver<AgentEvent>) {
        let (event_tx, event_rx) = async_channel::unbounded();
        let (cmd_tx, cmd_rx) = async_channel::unbounded::<Command>();
        let loaded = config.store.load();
        let state = AgentState::from_persisted(loaded.clone().unwrap_or_default(), now_ms());
        let state = Arc::new(Mutex::new(state));
        let shared_state = state.clone();
        if let Err(e) = &loaded {
            let _ = event_tx.try_send(AgentEvent::Diagnostic {
                task_id: None,
                label: "store load failed".into(),
                detail: e.clone(),
            });
        }
        std::thread::Builder::new()
            .name("notefig-agent".into())
            .spawn(move || {
                let executor: Spawner = Rc::new(smol::LocalExecutor::new());
                let sh = Rc::new(Shared {
                    spawner: executor.clone(),
                    db: Db::new(shared_state, event_tx, config.store),
                    services: config.services,
                    relay: config.relay,
                    startup_timeout: config.startup_timeout,
                    transport: config.transport,
                });
                // Boot reconcile is durable at once.
                sh.db.mark_dirty();
                sh.db.flush();
                let rt = Rc::new(Runtime {
                    sh: sh.clone(),
                    tasks: RefCell::default(),
                    trusted_this_run: RefCell::default(),
                    probe_dir: config.probe_dir,
                    probe: RefCell::default(),
                    probe_catalogs: config.probe_catalogs,
                });
                let (discover, probe) = (config.discover_on_boot, config.probe_catalogs);
                let boot = rt.clone();
                executor
                    .spawn(async move {
                        if discover {
                            boot.clone().rescan(None).await;
                        }
                        if probe {
                            // At boot, then every 6 hours (stale ones only).
                            loop {
                                let _ = boot.check_all_catalogs().recv().await;
                                smol::Timer::after(PROBE_CHECK_EVERY).await;
                            }
                        }
                    })
                    .detach();
                let flusher = sh.clone();
                executor
                    .spawn(async move {
                        loop {
                            smol::Timer::after(FLUSH_EVERY).await;
                            flusher.db.flush();
                        }
                    })
                    .detach();
                let ex = executor.clone();
                smol::block_on(ex.run(async move {
                    while let Ok(cmd) = cmd_rx.recv().await {
                        cmd(&rt);
                    }
                    // Every handle dropped: shut down.
                    rt.dispose_all();
                    rt.sh.db.flush();
                    notefig_agent::process::kill_all();
                }));
            })
            .expect("spawn agent thread");
        (AgentHandle { cmd: cmd_tx, state }, event_rx)
    }
}

/// The app's handle (cheap to clone, `Send`).
#[derive(Clone)]
pub struct AgentHandle {
    cmd: async_channel::Sender<Command>,
    state: Arc<Mutex<AgentState>>,
}

impl AgentHandle {
    fn exec(&self, f: impl FnOnce(&Rc<Runtime>) + Send + 'static) {
        let _ = self.cmd.try_send(Box::new(f));
    }

    fn ask<T: Send + 'static>(
        &self,
        f: impl FnOnce(&Rc<Runtime>, async_channel::Sender<T>) + Send + 'static,
    ) -> Pending<T> {
        let (tx, rx) = pending();
        self.exec(move |rt| f(rt, tx));
        rx
    }

    // ── snapshot reads ──

    /// Lock the live state (keep it short).
    pub fn state(&self) -> MutexGuard<'_, AgentState> {
        self.state.lock().unwrap()
    }
    pub fn task(&self, task_id: &str) -> Option<AgentTaskRow> {
        self.state().tasks.get(task_id).cloned()
    }
    /// Every task row, newest first (descending ids).
    pub fn tasks(&self) -> Vec<AgentTaskRow> {
        self.state().tasks.values().cloned().collect()
    }
    /// A workspace's sessions by `updated_at`, newest first.
    pub fn tasks_for_workspace(&self, workspace: &str) -> Vec<AgentTaskRow> {
        let mut rows: Vec<AgentTaskRow> = self
            .state()
            .tasks
            .values()
            .filter(|r| r.workspace_path == workspace)
            .cloned()
            .collect();
        rows.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        rows
    }
    pub fn turns(&self, task_id: &str) -> Vec<AgentTurn> {
        self.state().turns_for_task(task_id)
    }
    /// A task's transcript in render order.
    pub fn entries(&self, task_id: &str) -> Vec<AgentEntry> {
        self.state().entries_for_task(task_id)
    }
    pub fn permission_requests(&self, task_id: &str) -> Vec<PermissionRequestRow> {
        self.state()
            .permissions
            .values()
            .filter(|p| p.task_id == task_id)
            .cloned()
            .collect()
    }
    pub fn pending_permissions(&self, task_id: &str) -> Vec<PermissionRequestRow> {
        self.permission_requests(task_id)
            .into_iter()
            .filter(|p| p.status == PermissionStatus::Pending)
            .collect()
    }
    pub fn usage_buckets(&self) -> Vec<UsageBucket> {
        self.state().usage_buckets.clone()
    }
    pub fn usage_limits(&self) -> Vec<StoredLimits> {
        self.state().usage_limits.values().cloned().collect()
    }
    pub fn is_trusted_persisted(&self, workspace: &str) -> bool {
        self.state().kv.get(&trust_key(workspace)) == Some(&Value::Bool(true))
    }
    /// Whether a harness has reached the model on this machine.
    pub fn is_signed_in(&self, harness_id: &str) -> bool {
        self.state().kv.get(&format!("agent/auth:{harness_id}")) == Some(&Value::Bool(true))
    }

    // ── harness views ──

    /// Every harness as settings lists it (disabled / missing included).
    pub fn harness_settings(&self) -> Vec<HarnessSettingsRow> {
        harness_settings_rows(&self.state().harnesses)
    }
    /// What the pickers offer.
    pub fn pickable_harnesses(&self) -> Vec<HarnessDefinition> {
        pickable_harnesses(self.state().harnesses.values())
    }
    pub fn configured_harnesses(&self) -> Vec<HarnessDefinition> {
        configured_harnesses(self.state().harnesses.values())
    }
    pub fn harness_label(&self, harness_id: &str) -> String {
        harness_label(&self.state().harnesses, harness_id)
    }
    pub fn harness_catalog(&self, harness_id: &str) -> Option<HarnessCatalog> {
        self.state()
            .harnesses
            .get(harness_id)
            .and_then(|r| r.catalog.clone())
    }
    /// What a harness reports beyond tokens (greys out what it never fills).
    pub fn harness_reporting(&self, harness_id: &str) -> UsageReporting {
        let state = self.state();
        let seen_cost = state
            .usage_buckets
            .iter()
            .any(|b| b.harness_id == harness_id && b.summary.total.cost.is_some());
        let seen_limits = state.usage_limits.contains_key(harness_id);
        notefig_harness_adapters::reporting_for(
            harness_definition(&state.harnesses, harness_id).as_ref(),
            UsageReporting {
                cost: seen_cost,
                limits: seen_limits,
            },
        )
    }
    /// `cd <ws> && claude --resume <id>` for a task, if its harness has one.
    pub fn resume_command(&self, task_id: &str, dialect: ResumeShellDialect) -> Option<String> {
        let state = self.state();
        let row = state.tasks.get(task_id)?;
        let def = harness_definition(&state.harnesses, &row.harness_id)?;
        build_harness_resume_command(
            &def,
            row.session_id.as_deref()?,
            &row.workspace_path,
            dialect,
        )
    }

    // ── workspace / trust ──

    pub fn is_trusted(&self, workspace: &str) -> Pending<bool> {
        let ws = workspace.to_string();
        self.ask(move |rt, tx| {
            let _ = tx.try_send(rt.is_trusted(&ws));
        })
    }
    /// The user confirmed the trust prompt for this workspace.
    pub fn trust(&self, workspace: &str) {
        let ws = workspace.to_string();
        self.exec(move |rt| {
            rt.trusted_this_run.borrow_mut().insert(ws.clone());
            rt.sh.db.kv_set(&trust_key(&ws), Value::Bool(true));
        });
    }

    /// The user starts a session: trust gate, then the row (status
    /// `starting`) exists before this answers; spawn + handshake continue.
    pub fn start_task(&self, workspace: &str, harness_id: &str) -> Pending<StartResult> {
        let (ws, id) = (workspace.to_string(), harness_id.to_string());
        self.ask(move |rt, tx| {
            if !rt.is_trusted(&ws) {
                let _ = tx.try_send(StartResult::NeedsTrust);
                return;
            }
            let Some(harness) = rt.definition(&id) else {
                let _ = tx.try_send(StartResult::UnknownHarness);
                return;
            };
            let task = rt.start_task(&ws, harness);
            let _ = tx.try_send(StartResult::Started {
                task_id: task.id.clone(),
            });
        })
    }

    /// Resolves when the task's start (or revival) finishes.
    pub fn when_started(&self, task_id: &str) -> Pending<Result<(), String>> {
        let id = task_id.to_string();
        let (tx, rx) = pending();
        self.exec(move |rt| match rt.get_or_revive(&id) {
            Some(task) => {
                let waiter = task.when_started();
                rt.spawn(async move {
                    let _ = tx
                        .send(
                            waiter
                                .recv()
                                .await
                                .unwrap_or(Err("agent task is gone".into())),
                        )
                        .await;
                });
            }
            None => {
                let _ = tx.try_send(Err("agent task is not started".into()));
            }
        });
        rx
    }

    /// Send a prompt (revives a restored session transparently; queues FIFO).
    pub fn prompt(&self, task_id: &str, text: &str, extras: PromptExtras) -> Pending<PromptHandle> {
        let (id, text) = (task_id.to_string(), text.to_string());
        self.ask(move |rt, tx| {
            let handle = match rt.get_or_revive(&id) {
                Some(task) => {
                    let (turn_id, rx) = task.prompt(&text, extras, false);
                    PromptHandle {
                        turn_id,
                        completed: Pending(rx),
                    }
                }
                None => {
                    let (otx, orx) = pending();
                    let _ = otx.try_send(TurnOutcome::Error("agent task is not started".into()));
                    PromptHandle {
                        turn_id: notefig_agent::ids::new_turn_id(),
                        completed: orx,
                    }
                }
            };
            let _ = tx.try_send(handle);
        })
    }

    /// A prompt from an in-document widget (`promptFromWidget`).
    pub fn prompt_from_widget(
        &self,
        task_id: &str,
        text: &str,
        source: WidgetPromptSource,
        extras: PromptExtras,
    ) -> Pending<PromptHandle> {
        let (text, extras) = widget_prompt(text, &source, extras);
        self.prompt(task_id, &text, extras)
    }

    pub fn remove_queued_prompt(&self, task_id: &str, turn_id: &str) {
        let (id, turn) = (task_id.to_string(), turn_id.to_string());
        self.exec(move |rt| {
            if let Some(task) = rt.live(&id) {
                task.remove_queued_prompt(&turn);
            }
        });
    }

    pub fn cancel(&self, task_id: &str) -> Pending<Result<(), String>> {
        let id = task_id.to_string();
        self.ask(move |rt, tx| {
            let _ = tx.try_send(match rt.live(&id) {
                Some(task) => {
                    task.cancel();
                    Ok(())
                }
                None => Err("agent task is not started".into()),
            });
        })
    }

    /// Escape: cancel, and forget the turn if nothing came back yet (true =
    /// put the prompt back into the composer).
    pub fn cancel_turn_and_forget(&self, task_id: &str) -> Pending<bool> {
        let id = task_id.to_string();
        self.ask(move |rt, tx| {
            let _ = tx.try_send(rt.live(&id).is_some_and(|t| t.cancel_and_forget()));
        })
    }

    pub fn revive(&self, task_id: &str) {
        let id = task_id.to_string();
        self.exec(move |rt| {
            rt.revive(&id);
        });
    }

    /// Manual "refresh session": live → close+load in place; restored → revive.
    pub fn refresh(&self, task_id: &str) -> Pending<Result<(), String>> {
        let id = task_id.to_string();
        let (tx, rx) = pending();
        self.exec(move |rt| match rt.live(&id) {
            Some(task) => rt.spawn(async move {
                let _ = tx.send(task.refresh_from_harness().await).await;
            }),
            None => {
                let revived = rt.revive(&id);
                let _ = tx.try_send(if revived.is_some() {
                    Ok(())
                } else {
                    Err("nothing to refresh".into())
                });
            }
        });
        rx
    }

    /// Remove a session everywhere (runtime, transcript, persisted row).
    pub fn delete(&self, task_id: &str) -> Pending<()> {
        let id = task_id.to_string();
        self.ask(move |rt, tx| {
            rt.dispose_task(&id);
            rt.sh.db.purge_task(&id);
            let _ = tx.try_send(());
        })
    }

    pub fn is_reachable(&self, task_id: &str) -> bool {
        // Live tasks always have a row with a non-terminal-for-revival status.
        self.task(task_id).is_some_and(|r| {
            r.status != TaskStatus::Unavailable
                && (r.status != TaskStatus::Restored || r.session_id.is_some())
        })
    }

    pub fn respond_permission(
        &self,
        task_id: &str,
        request_id: &str,
        outcome: PermissionOutcome,
    ) -> Pending<Result<(), String>> {
        let (id, req) = (task_id.to_string(), request_id.to_string());
        self.ask(move |rt, tx| {
            let _ = tx.try_send(match rt.live(&id) {
                Some(task) if task.respond_permission(&req, outcome) => Ok(()),
                Some(_) => Err("no such pending request".into()),
                None => Err("agent task is not started".into()),
            });
        })
    }

    pub fn authenticate(&self, task_id: &str, method_id: &str) -> Pending<Result<(), String>> {
        let (id, method) = (task_id.to_string(), method_id.to_string());
        let (tx, rx) = pending();
        self.exec(move |rt| match rt.live(&id) {
            Some(task) => rt.spawn(async move {
                let _ = tx.send(task.authenticate(method).await).await;
            }),
            None => {
                let _ = tx.try_send(Err("agent task is not started".into()));
            }
        });
        rx
    }

    /// "I've signed in": re-send the prompt the auth block held.
    pub fn retry_after_auth(&self, task_id: &str) -> Pending<Result<(), String>> {
        let id = task_id.to_string();
        self.ask(move |rt, tx| {
            let _ = tx.try_send(match rt.live(&id) {
                Some(task) => {
                    task.retry_held_prompt();
                    Ok(())
                }
                None => Err("agent task is not started".into()),
            });
        })
    }

    /// Switch a session setting (a restored row revives first).
    pub fn set_config_option(
        &self,
        task_id: &str,
        option_id: &str,
        value: &str,
    ) -> Pending<Result<(), String>> {
        let (id, option, value) = (
            task_id.to_string(),
            option_id.to_string(),
            value.to_string(),
        );
        let (tx, rx) = pending();
        self.exec(move |rt| match rt.get_or_revive(&id) {
            Some(task) => rt.spawn(async move {
                let started = task
                    .when_started()
                    .recv()
                    .await
                    .unwrap_or(Err("agent task is gone".into()));
                let result = match started {
                    Ok(()) => task.set_config_option(option, value).await,
                    Err(e) => Err(e),
                };
                let _ = tx.send(result).await;
            }),
            None => {
                let _ = tx.try_send(Err("agent task is not started".into()));
            }
        });
        rx
    }

    /// Workspace closed: dispose its tasks; sessionful rows → `restored`.
    pub fn dispose_workspace(&self, workspace: &str) -> Pending<()> {
        let ws = workspace.to_string();
        self.ask(move |rt, tx| {
            rt.dispose_workspace(&ws);
            let _ = tx.try_send(());
        })
    }

    /// App exit: dispose everything, flush, kill every child.
    pub fn shutdown(&self) -> Pending<()> {
        let rx = self.ask(|rt, tx| {
            rt.dispose_all();
            rt.sh.db.flush();
            notefig_agent::process::kill_all();
            let _ = tx.try_send(());
        });
        self.cmd.close();
        rx
    }

    // ── harness settings ──

    pub fn save_override(
        &self,
        harness_id: &str,
        r#override: Option<HarnessOverride>,
    ) -> Pending<bool> {
        let id = harness_id.to_string();
        self.ask(move |rt, tx| {
            if !is_built_in(&id) {
                let _ = tx.try_send(false);
                return;
            }
            let has_row = rt.sh.db.lock().harnesses.contains_key(&id);
            if r#override.is_some() || has_row {
                let o = r#override.map(|o| HarnessOverride {
                    id: id.clone(),
                    ..o
                });
                rt.sh.db.upsert_harness(&id, |row| row.r#override = o);
            }
            let _ = tx.try_send(true);
            let rt2 = rt.clone();
            rt.spawn(async move {
                rt2.rescan(Some(vec![id])).await;
            });
        })
    }

    pub fn save_custom(&self, harness_id: &str, entry: CustomHarnessEntry) -> Pending<bool> {
        let id = harness_id.to_string();
        self.ask(move |rt, tx| {
            let entry = CustomHarnessEntry {
                id: id.clone(),
                ..entry
            };
            if is_built_in(&id) || !entry.is_valid() {
                let _ = tx.try_send(false);
                return;
            }
            rt.sh.db.upsert_harness(&id, |row| row.custom = Some(entry));
            let _ = tx.try_send(true);
            let rt2 = rt.clone();
            rt.spawn(async move {
                rt2.rescan(Some(vec![id])).await;
            });
        })
    }

    pub fn set_harness_enabled(&self, harness_id: &str, enabled: bool) {
        let id = harness_id.to_string();
        self.exec(move |rt| {
            let row = rt.sh.db.lock().harnesses.get(&id).cloned();
            if let Some(custom) = row.as_ref().and_then(|r| r.custom.clone()) {
                rt.sh.db.upsert_harness(&id, |r| {
                    r.custom = Some(CustomHarnessEntry { enabled, ..custom })
                });
                if enabled && rt.probe_catalogs {
                    let _ = rt.check_catalogs(vec![id], false);
                }
                return;
            }
            if !is_built_in(&id) {
                return;
            }
            let natural = row
                .as_ref()
                .and_then(|r| r.install.as_ref())
                .is_none_or(|i| i.found);
            let next = toggle_override_enabled(
                row.as_ref().and_then(|r| r.r#override.as_ref()),
                &id,
                enabled,
                natural,
            );
            if next.is_some() || row.is_some() {
                rt.sh.db.upsert_harness(&id, |r| r.r#override = next);
            }
            if enabled && rt.probe_catalogs {
                let _ = rt.check_catalogs(vec![id], false);
            }
        });
    }

    pub fn remove_custom_harness(&self, harness_id: &str) {
        let id = harness_id.to_string();
        self.exec(move |rt| {
            let removed = {
                let mut state = rt.sh.db.lock();
                if state.harnesses.get(&id).is_some_and(|r| r.custom.is_some()) {
                    state.harnesses.remove(&id);
                    true
                } else {
                    false
                }
            };
            if removed {
                rt.sh.db.mark_dirty();
                rt.sh.db.emit(AgentEvent::HarnessesChanged);
            }
        });
    }

    /// Re-run install discovery (one login-shell batch). None = couldn't check.
    pub fn rescan_harnesses(&self) -> Pending<Option<Vec<HarnessDiscoveryResult>>> {
        let (tx, rx) = pending();
        self.exec(move |rt| {
            let rt2 = rt.clone();
            rt.spawn(async move {
                let _ = tx.send(rt2.rescan(None).await).await;
            });
        });
        rx
    }

    /// Probe catalogs now (`only` one harness; `force` ignores staleness).
    pub fn probe_catalogs(&self, only: Option<&str>, force: bool) -> Pending<()> {
        let only = only.map(str::to_string);
        let (tx, rx) = pending();
        self.exec(move |rt| {
            let done = match only {
                Some(id) => rt.check_catalogs(vec![id], force),
                None if force => {
                    let ids = configured_harnesses(rt.sh.db.lock().harnesses.values())
                        .into_iter()
                        .map(|h| h.id)
                        .collect();
                    rt.check_catalogs(ids, true)
                }
                None => rt.check_all_catalogs(),
            };
            rt.spawn(async move {
                let _ = done.recv().await;
                let _ = tx.send(()).await;
            });
        });
        rx
    }

    /// `startTask`: start a task with no gates (no trust check, no tab), for
    /// code that already holds the user's go-ahead (a widget's send). The
    /// row exists (status `starting`) when this answers; `when_started`
    /// says when it can be prompted.
    pub fn start_ungated(&self, workspace: &str, harness_id: &str) -> Pending<Result<String, String>> {
        let (ws, id) = (workspace.to_string(), harness_id.to_string());
        self.ask(move |rt, tx| {
            let result = match rt.definition(&id) {
                Some(harness) => Ok(rt.start_task(&ws, harness).id.clone()),
                None => Err("unknown harness".to_string()),
            };
            let _ = tx.try_send(result);
        })
    }

    /// Resolves once every command sent before it has run (a barrier).
    pub fn sync(&self) -> Pending<()> {
        self.ask(|_, tx| {
            let _ = tx.try_send(());
        })
    }
}
