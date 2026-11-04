//! One live agent session (port of `AgentTask` in `agent-service.ts`):
//! process + ACP connection + MCP endpoint, the FIFO prompt queue, the
//! auth hold, turn state (run coalescing through the markdown joiner, plan
//! slot, task-level tool-call coalescing, lingering-tool sweep), usage
//! normalization, the permission broker, `session/load` replay staging.
//!
//! Everything runs on the host's single-threaded executor; `RefCell`
//! borrows are never held across an `.await`.

use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::rc::{Rc, Weak};
use std::sync::Arc;

use serde_json::{Value, json};
use smol::io::{AsyncBufReadExt, BufReader};
use smol::stream::StreamExt;

use notefig_agent::acp::{AcpClient, AcpDelegate};
use crate::runtime::events::AgentEvent;
use notefig_harness_adapters::{
    HarnessAdapter, InvokeContext, SpawnPrep, is_main_agent, is_subagent_chunk, limits_from,
    needs_sign_in, tool_call_title,
};
use notefig_agent::harness::{HarnessDefinition, resolve_harness_spawn};
use crate::runtime::host::Shared;
use notefig_agent::ids::{new_event_id, new_turn_id, now_ms};
use notefig_agent::joiner::MarkdownJoiner;
use notefig_agent::mcp::{McpEndpoint, McpHost};
use notefig_agent::model::*;
use notefig_agent::paths::resolve_workspace_path;
use notefig_agent::process::{KillGuard, SpawnSpec, with_timeout};
use notefig_agent::prompt::{PromptExtras, compose_prompt, place_commands, title_from_prompt};
use notefig_agent::rpc::LocalBoxFuture;
use notefig_agent::services::{ClientRequest, ClientServices, reply_pair};
use notefig_agent::usage::{UsageReader, context_from, normalize_turn_usage};

const NEW_TASK_TITLE: &str = "New task";
const STDERR_TAIL: usize = 20;

#[derive(Debug, Clone)]
pub(crate) struct QueuedPrompt {
    pub turn_id: String,
    pub text: String,
    pub extras: PromptExtras,
}

/// Where a turn's entries land: the live store, or a replay stage
/// committed in one swap when `session/load` resolves.
#[derive(Clone)]
enum Target {
    Live,
    Stage(Rc<RefCell<BTreeMap<String, AgentEntry>>>),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum RunKind {
    Assistant,
    Thought,
}

struct Run {
    kind: RunKind,
    entry_id: String,
    text: String,
}

struct TurnState {
    turn_id: String,
    joiner: MarkdownJoiner,
    run: Option<Run>,
    plan_entry_id: Option<String>,
    user_text: String,
    target: Target,
}

impl TurnState {
    fn new(turn_id: String, user_text: String, target: Target) -> Self {
        TurnState {
            turn_id,
            joiner: MarkdownJoiner::new(),
            run: None,
            plan_entry_id: None,
            user_text,
            target,
        }
    }
    fn is_replay(&self) -> bool {
        matches!(self.target, Target::Stage(_))
    }
}

#[derive(Debug, Clone)]
struct StartError {
    message: String,
    timed_out: bool,
}

#[derive(Default)]
struct Inner {
    client: Option<Rc<AcpClient>>,
    guard: Option<KillGuard>,
    exit: Option<smol::Task<Option<i32>>>,
    io: Vec<smol::Task<()>>,
    stderr_tail: VecDeque<String>,
    mcp: Option<McpEndpoint>,
    prep: Option<SpawnPrep>,
    session_id: Option<String>,
    status: Option<TaskStatus>,
    title: String,
    current_turn: Option<TurnState>,
    tool_event_ids: HashMap<String, String>,
    pending: VecDeque<QueuedPrompt>,
    resolvers: HashMap<String, async_channel::Sender<TurnOutcome>>,
    draining: bool,
    held: Option<QueuedPrompt>,
    auth_blocked: bool,
    start_called: bool,
    signed_in_marked: bool,
    disposed: bool,
    last_usage_update: Option<Value>,
    turn_usage_updates: Vec<Value>,
    cost_baseline: Option<f64>,
    last_limits_key: Option<String>,
    permissions: HashMap<String, async_channel::Sender<PermissionOutcome>>,
    next_permission: u64,
    start_result: Option<Result<(), String>>,
    start_waiters: Vec<async_channel::Sender<Result<(), String>>>,
}

pub(crate) struct Task {
    pub id: String,
    pub workspace: String,
    pub harness: HarnessDefinition,
    pub adapter: &'static dyn HarnessAdapter,
    pub parent: Option<String>,
    sh: Rc<Shared>,
    me: Weak<Task>,
    st: RefCell<Inner>,
}

fn error_message(e: impl std::fmt::Display) -> String {
    e.to_string()
}

impl Task {
    pub fn new(
        sh: Rc<Shared>,
        id: String,
        workspace: String,
        harness: HarnessDefinition,
        parent: Option<String>,
    ) -> Rc<Task> {
        let adapter = notefig_harness_adapters::adapter_for(&harness);
        Rc::new_cyclic(|me| Task {
            id,
            workspace,
            harness,
            adapter,
            parent,
            sh,
            me: me.clone(),
            st: RefCell::new(Inner {
                title: NEW_TASK_TITLE.into(),
                ..Default::default()
            }),
        })
    }

    fn rc(&self) -> Rc<Task> {
        self.me.upgrade().expect("task alive")
    }

    fn warn(&self, label: &str, detail: &str) {
        self.sh.db.emit(AgentEvent::Diagnostic {
            task_id: Some(self.id.clone()),
            label: label.into(),
            detail: detail.into(),
        });
    }

    // ── status / rows ───────────────────────────────────────────────────

    pub fn current_status(&self) -> TaskStatus {
        self.sh
            .db
            .task(&self.id)
            .map(|r| r.status)
            .or(self.st.borrow().status)
            .unwrap_or(TaskStatus::Starting)
    }

    fn set_status(&self, status: TaskStatus) {
        {
            let mut st = self.st.borrow_mut();
            if st.disposed {
                return;
            }
            st.status = Some(status);
        }
        self.sh.db.update_task(&self.id, |row| {
            row.status = status;
            row.updated_at = now_ms();
        });
    }

    fn upsert_task_row(&self) {
        let status = self.st.borrow().status.unwrap_or(TaskStatus::Starting);
        if let Some(existing) = self.sh.db.task(&self.id) {
            self.st.borrow_mut().title = existing.title.clone();
            self.sh.db.update_task(&self.id, |row| {
                row.status = status;
                row.updated_at = now_ms();
            });
            return;
        }
        let now = now_ms();
        self.sh.db.insert_task(AgentTaskRow {
            task_id: self.id.clone(),
            parent_task_id: self.parent.clone(),
            workspace_path: self.workspace.clone(),
            title: NEW_TASK_TITLE.into(),
            status,
            harness_id: self.harness.id.clone(),
            session_id: None,
            created_at: now,
            updated_at: now,
            last_settled: None,
            usage: None,
            auth_hint: None,
            auth_required: false,
            auth_methods: vec![],
            config_options: None,
            commands: None,
        });
    }

    pub fn session_id(&self) -> Option<String> {
        self.st.borrow().session_id.clone()
    }

    pub fn is_disposed(&self) -> bool {
        self.st.borrow().disposed
    }

    // ── start ───────────────────────────────────────────────────────────

    /// Resolves when the start finished (Ok once idle).
    pub fn when_started(&self) -> async_channel::Receiver<Result<(), String>> {
        let (tx, rx) = async_channel::bounded(1);
        let mut st = self.st.borrow_mut();
        match &st.start_result {
            Some(result) => {
                let _ = tx.try_send(result.clone());
            }
            None => st.start_waiters.push(tx),
        }
        rx
    }

    fn finish_start(&self, result: Result<(), String>) {
        let waiters = {
            let mut st = self.st.borrow_mut();
            st.start_result = Some(result.clone());
            std::mem::take(&mut st.start_waiters)
        };
        for w in waiters {
            let _ = w.try_send(result.clone());
        }
    }

    /// Spawn + connect + session/new (or session/load for a revival).
    /// The row is inserted (and prompts start queueing) synchronously,
    /// before the returned future is first polled.
    pub fn start(
        self: Rc<Self>,
        resume: Option<String>,
    ) -> impl std::future::Future<Output = Result<(), String>> {
        self.st.borrow_mut().start_called = true;
        self.upsert_task_row();
        self.start_async(resume)
    }

    async fn start_async(self: Rc<Self>, resume: Option<String>) -> Result<(), String> {
        match self.clone().start_inner(resume.clone()).await {
            Ok(()) => {
                let session_id = self.session_id();
                self.sh
                    .db
                    .update_task(&self.id, |row| row.session_id = session_id);
                self.set_status(TaskStatus::Idle);
                let kick = {
                    let st = self.st.borrow();
                    !st.pending.is_empty() && !st.auth_blocked
                };
                if kick {
                    self.kick_drain();
                }
                self.finish_start(Ok(()));
                Ok(())
            }
            Err(StartError { message, timed_out }) => {
                let message = self.with_stderr_hint(message);
                self.warn("start failed", &message);
                self.set_status(if resume.is_some() && !timed_out {
                    TaskStatus::Unavailable
                } else {
                    TaskStatus::Error
                });
                let pending: Vec<QueuedPrompt> = self.st.borrow_mut().pending.drain(..).collect();
                for q in pending {
                    self.settle_queued_turn(&q.turn_id, TurnStatus::Error, Some(message.clone()));
                }
                if !self.is_disposed() {
                    self.teardown();
                }
                self.finish_start(Err(message.clone()));
                Err(message)
            }
        }
    }

    fn with_stderr_hint(&self, message: String) -> String {
        let st = self.st.borrow();
        match st.stderr_tail.back() {
            Some(line) if message.contains("agent process ended") => format!("{message} ({line})"),
            _ => message,
        }
    }

    async fn start_inner(self: Rc<Self>, resume: Option<String>) -> Result<(), StartError> {
        let fail = |message: String| StartError {
            message,
            timed_out: false,
        };
        let timeout = self.sh.startup_timeout;
        // MCP channel first: the harness spawn may need its address.
        let host: Rc<dyn McpHost> = Rc::new(TaskMcpHost(self.me.clone()));
        let endpoint = McpEndpoint::start(&self.sh.spawner, host, &self.sh.relay)
            .await
            .map_err(|e| fail(format!("failed to bind mcp relay listener: {e}")))?;
        let server = endpoint.server.clone();
        self.st.borrow_mut().mcp = Some(endpoint);

        let workspace = PathBuf::from(&self.workspace);
        let write_file = |path: &Path, content: &str| -> Result<(), String> {
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir).map_err(error_message)?;
            }
            std::fs::write(path, content).map_err(error_message)
        };
        let warn = |label: &str, detail: &str| self.warn(label, detail);
        let prep = self.adapter.on_invoke(&InvokeContext {
            workspace_path: &workspace,
            harness_env: &self.harness.env,
            mcp_server: Some(&server),
            write_file: &write_file,
            warn: &warn,
        });
        self.st.borrow_mut().prep = Some(prep.clone());

        let (args, cwd) = resolve_harness_spawn(&self.harness, &self.workspace);
        let mut env = self.harness.env.clone();
        env.extend(prep.env.clone());
        let process = self
            .sh
            .transport
            .open(SpawnSpec {
                harness_id: self.harness.id.clone(),
                task_id: self.id.clone(),
                program: self.harness.command.clone(),
                args,
                cwd: cwd.into(),
                env,
            })
            .await
            .map_err(|e| fail(e.message))?;

        let delegate: Rc<dyn AcpDelegate> = Rc::new(TaskDelegate(self.me.clone()));
        let me = self.me.clone();
        let client = AcpClient::new(
            &self.sh.spawner,
            process.reader,
            process.writer,
            delegate,
            true,
            move || {
                if let Some(task) = me.upgrade() {
                    task.on_transport_closed();
                }
            },
        );
        let me = self.me.clone();
        let stderr = process.stderr;
        let stderr_task = self.sh.spawner.spawn(async move {
            let Some(stderr) = stderr else { return };
            let mut lines = BufReader::new(stderr).lines();
            while let Some(Ok(line)) = lines.next().await {
                let Some(task) = me.upgrade() else { break };
                {
                    let mut st = task.st.borrow_mut();
                    st.stderr_tail.push_back(line.clone());
                    if st.stderr_tail.len() > STDERR_TAIL {
                        st.stderr_tail.pop_front();
                    }
                }
                task.warn("stderr", &line);
            }
        });
        {
            let mut st = self.st.borrow_mut();
            st.client = Some(client.clone());
            st.guard = process.guard;
            st.exit = process.exit;
            st.io.push(stderr_task);
        }

        let timed = |step: &str| StartError {
            message: format!("agent startup timed out ({step})"),
            timed_out: true,
        };
        with_timeout(timeout, client.connect(true, self.adapter.client_meta()))
            .await
            .ok_or_else(|| timed("initialize"))?
            .map_err(|e| fail(e.to_string()))?;

        let mcp_servers = self.current_mcp_servers();
        match resume {
            Some(session_id) => {
                with_timeout(
                    timeout,
                    self.clone().resume_session(session_id, mcp_servers, false),
                )
                .await
                .ok_or_else(|| timed("session/load"))?
                .map_err(fail)?;
            }
            None => {
                let session_id = with_timeout(
                    timeout,
                    client.new_session(&self.workspace, mcp_servers, &prep.session_params),
                )
                .await
                .ok_or_else(|| timed("session/new"))?
                .map_err(|e| fail(e.to_string()))?;
                self.st.borrow_mut().session_id = Some(session_id);
            }
        }
        Ok(())
    }

    fn current_mcp_servers(&self) -> Vec<Value> {
        let st = self.st.borrow();
        match (&st.prep, &st.mcp) {
            (Some(prep), Some(mcp)) if prep.pass_through_session_new => vec![mcp.server.to_acp()],
            _ => vec![],
        }
    }

    fn teardown(&self) {
        let (client, guard, mcp, io, exit) = {
            let mut st = self.st.borrow_mut();
            (
                st.client.take(),
                st.guard.take(),
                st.mcp.take(),
                std::mem::take(&mut st.io),
                st.exit.take(),
            )
        };
        if let Some(client) = client {
            client.close();
        }
        drop(guard);
        drop(mcp);
        drop(io);
        drop(exit);
    }

    fn on_transport_closed(&self) {
        let me = self.rc();
        self.sh
            .spawner
            .spawn(async move {
                let exit = me.st.borrow_mut().exit.take();
                let code = match exit {
                    Some(exit) => with_timeout(std::time::Duration::from_secs(2), exit)
                        .await
                        .flatten(),
                    None => None,
                };
                let mut message = match code {
                    Some(code) => format!("agent process exited (code {code})"),
                    None => "agent process ended".to_string(),
                };
                if let Some(line) = me.st.borrow().stderr_tail.back() {
                    message.push_str(&format!(": {line}"));
                }
                me.handle_transport_close(message);
            })
            .detach();
    }

    fn handle_transport_close(&self, message: String) {
        if self.is_disposed() {
            return;
        }
        self.cancel_all_permissions();
        self.warn("transport closed", &message);
        let replaying = self
            .st
            .borrow()
            .current_turn
            .as_ref()
            .map(|t| t.is_replay());
        match replaying {
            Some(true) => {
                self.st.borrow_mut().current_turn = None;
                self.set_status(TaskStatus::Error);
            }
            Some(false) => {
                self.finish_turn(None, TurnStatus::Error, Some(message));
            }
            None => {
                if self.current_status() != TaskStatus::Unavailable {
                    self.set_status(TaskStatus::Error);
                }
            }
        }
    }

    // ── replay ──────────────────────────────────────────────────────────

    async fn resume_session(
        self: Rc<Self>,
        session_id: String,
        mcp_servers: Vec<Value>,
        close_first: bool,
    ) -> Result<(), String> {
        let client = self
            .st
            .borrow()
            .client
            .clone()
            .ok_or("ACP client not connected")?;
        let stage: Rc<RefCell<BTreeMap<String, AgentEntry>>> = Rc::default();
        let turn_id = new_turn_id();
        let replay_turn = AgentTurn {
            turn_id: turn_id.clone(),
            task_id: self.id.clone(),
            session_id: session_id.clone(),
            status: TurnStatus::Completed,
            stop_reason: Some("replay".into()),
            error: None,
            started_at: now_ms(),
            usage: None,
        };
        {
            let mut st = self.st.borrow_mut();
            st.tool_event_ids.clear();
            st.current_turn = Some(TurnState::new(
                turn_id.clone(),
                String::new(),
                Target::Stage(stage.clone()),
            ));
        }
        let ext = self
            .st
            .borrow()
            .prep
            .as_ref()
            .map(|p| p.session_params.clone())
            .unwrap_or_default();
        let result: Result<(), String> = async {
            if close_first {
                match with_timeout(self.sh.startup_timeout, client.close_session(&session_id)).await
                {
                    Some(Ok(())) => {}
                    Some(Err(e)) => self.warn(
                        "session/close failed; transcript-only re-sync",
                        &e.to_string(),
                    ),
                    None => self.warn("session/close failed; transcript-only re-sync", "timed out"),
                }
            }
            client
                .load_session(&session_id, &self.workspace, mcp_servers, &ext)
                .await
                .map_err(error_message)?;
            let mut turn = {
                let mut st = self.st.borrow_mut();
                match st.current_turn.take() {
                    Some(t) if t.turn_id == turn_id => t,
                    other => {
                        st.current_turn = other;
                        return Err("agent process ended during session/load".to_string());
                    }
                }
            };
            self.st.borrow_mut().session_id = Some(session_id.clone());
            self.close_run(&mut turn);
            self.resolve_lingering_tool_calls(&turn.target, &turn_id, TurnStatus::Completed);
            let keep: Vec<String> = self
                .st
                .borrow()
                .pending
                .iter()
                .map(|p| p.turn_id.clone())
                .collect();
            self.commit_stage(&stage, replay_turn, &keep);
            Ok(())
        }
        .await;
        {
            let mut st = self.st.borrow_mut();
            if st
                .current_turn
                .as_ref()
                .is_some_and(|t| t.turn_id == turn_id)
            {
                st.current_turn = None;
            }
        }
        result
    }

    /// The atomic swap: the task's previous transcript is replaced by the
    /// replay turn + staged entries; queued turns keep their rows, moved
    /// behind the replay (fresh ids).
    fn commit_stage(
        &self,
        stage: &Rc<RefCell<BTreeMap<String, AgentEntry>>>,
        replay_turn: AgentTurn,
        keep: &[String],
    ) {
        {
            let mut state = self.sh.db.lock();
            state
                .turns
                .retain(|id, t| t.task_id != self.id || keep.contains(id));
            let previous = state.entries.remove(&self.id).unwrap_or_default();
            let mut next: BTreeMap<String, AgentEntry> = stage.borrow().clone();
            for (_, entry) in previous {
                if keep.contains(&entry.turn_id) {
                    let id = new_event_id();
                    next.insert(id.clone(), AgentEntry { id, ..entry });
                }
            }
            state.turns.insert(replay_turn.turn_id.clone(), replay_turn);
            state.entries.insert(self.id.clone(), next);
        }
        self.sh.db.emit(AgentEvent::TranscriptReplaced {
            task_id: self.id.clone(),
        });
    }

    // ── entry writes ────────────────────────────────────────────────────

    fn t_insert(&self, target: &Target, entry: AgentEntry) {
        match target {
            Target::Live => self.sh.db.insert_entry(entry),
            Target::Stage(stage) => {
                stage.borrow_mut().insert(entry.id.clone(), entry);
            }
        }
    }

    fn t_update(&self, target: &Target, id: &str, f: impl FnOnce(&mut AgentEntry)) -> bool {
        match target {
            Target::Live => self.sh.db.update_entry(&self.id, id, f),
            Target::Stage(stage) => match stage.borrow_mut().get_mut(id) {
                Some(entry) => {
                    f(entry);
                    true
                }
                None => false,
            },
        }
    }

    fn t_get(&self, target: &Target, id: &str) -> Option<AgentEntry> {
        match target {
            Target::Live => self.sh.db.entry(&self.id, id),
            Target::Stage(stage) => stage.borrow().get(id).cloned(),
        }
    }

    fn t_delete(&self, target: &Target, id: &str) {
        match target {
            Target::Live => self.sh.db.delete_entry(&self.id, id),
            Target::Stage(stage) => {
                stage.borrow_mut().remove(id);
            }
        }
    }

    fn t_entries(&self, target: &Target) -> Vec<AgentEntry> {
        match target {
            Target::Live => self.sh.db.entries_for_task(&self.id),
            Target::Stage(stage) => stage.borrow().values().cloned().collect(),
        }
    }

    fn new_entry(&self, turn_id: &str, kind: EntryType, live: bool) -> AgentEntry {
        AgentEntry {
            id: new_event_id(),
            task_id: self.id.clone(),
            turn_id: turn_id.into(),
            kind,
            text: None,
            tool_call_id: None,
            tool_call: None,
            plan: None,
            raw: None,
            created_at: live.then(now_ms),
        }
    }

    fn append_to_run(&self, turn: &mut TurnState, kind: RunKind, text: &str) {
        match &mut turn.run {
            Some(run) if run.kind == kind => {
                run.text.push_str(text);
                let full = run.text.clone();
                let id = run.entry_id.clone();
                self.t_update(&turn.target, &id, |e| e.text = Some(full));
            }
            _ => {
                let entry_kind = if kind == RunKind::Assistant {
                    EntryType::Assistant
                } else {
                    EntryType::Thought
                };
                let mut entry = self.new_entry(&turn.turn_id, entry_kind, !turn.is_replay());
                entry.text = Some(text.to_string());
                turn.run = Some(Run {
                    kind,
                    entry_id: entry.id.clone(),
                    text: text.to_string(),
                });
                self.t_insert(&turn.target, entry);
            }
        }
    }

    /// Close the open run (flushing buffered markdown first); a run that
    /// never got visible text is dropped.
    fn close_run(&self, turn: &mut TurnState) {
        let tail = turn.joiner.flush();
        if !tail.is_empty() {
            self.append_to_run(turn, RunKind::Assistant, &tail);
        }
        if let Some(run) = turn.run.take()
            && run.text.trim().is_empty()
        {
            self.t_delete(&turn.target, &run.entry_id);
        }
    }

    fn resolve_lingering_tool_calls(&self, target: &Target, turn_id: &str, status: TurnStatus) {
        let terminal = if status == TurnStatus::Completed {
            "completed"
        } else {
            "failed"
        };
        for entry in self.t_entries(target) {
            if entry.kind != EntryType::ToolCall
                || (entry.turn_id != turn_id && !entry.turn_id.is_empty())
            {
                continue;
            }
            let open = entry
                .tool_call
                .as_ref()
                .and_then(|t| t.get("status"))
                .and_then(Value::as_str)
                .is_none_or(|s| s == "pending" || s == "in_progress");
            if open {
                self.t_update(target, &entry.id, |e| {
                    if let Some(tc) = e.tool_call.as_mut() {
                        tc["status"] = Value::String(terminal.into());
                    }
                });
            }
        }
    }

    // ── session/update ──────────────────────────────────────────────────

    pub(crate) fn handle_notification(&self, params: &Value) {
        let Some(update) = params.get("update") else {
            return;
        };
        if is_subagent_chunk(self.adapter, update) {
            return;
        }
        if self.handle_task_update(update) {
            return;
        }
        let mut st = self.st.borrow_mut();
        let Some(turn) = st.current_turn.as_mut() else {
            return;
        };
        let kind = update
            .get("sessionUpdate")
            .and_then(Value::as_str)
            .unwrap_or("");
        let chunk = update
            .get("content")
            .map(content_block_text)
            .unwrap_or("")
            .to_string();
        match kind {
            "agent_message_chunk" => {
                if turn
                    .run
                    .as_ref()
                    .is_some_and(|r| r.kind == RunKind::Thought)
                {
                    self.close_run(turn);
                }
                let flushable = turn.joiner.process_text(&chunk);
                if !flushable.is_empty() {
                    self.append_to_run(turn, RunKind::Assistant, &flushable);
                }
            }
            "agent_thought_chunk" => {
                if chunk.is_empty() {
                    return;
                }
                if turn.run.as_ref().is_none_or(|r| r.kind != RunKind::Thought) {
                    self.close_run(turn);
                }
                self.append_to_run(turn, RunKind::Thought, &chunk);
            }
            "plan" => match turn.plan_entry_id.clone() {
                Some(id) => {
                    let plan = update.clone();
                    self.t_update(&turn.target, &id, |e| e.plan = Some(plan));
                }
                None => {
                    self.close_run(turn);
                    let mut entry =
                        self.new_entry(&turn.turn_id, EntryType::Plan, !turn.is_replay());
                    entry.plan = Some(update.clone());
                    turn.plan_entry_id = Some(entry.id.clone());
                    self.t_insert(&turn.target, entry);
                }
            },
            "user_message_chunk" => {
                if chunk.is_empty() {
                    return;
                }
                // A widget prompt's `resource_link` replays (claude-agent-acp)
                // as a text chunk holding the context URI: it is the previous
                // prompt's context, not a message. TS shows it as a stray
                // user line; folded away here.
                if notefig_agent::prompt::decode_widget_context_uri(chunk.trim()).is_some() {
                    return;
                }
                self.close_run(turn);
                turn.plan_entry_id = None;
                let mut entry = self.new_entry(&turn.turn_id, EntryType::User, !turn.is_replay());
                entry.text = Some(chunk);
                self.t_insert(&turn.target, entry);
            }
            other => {
                let mut entry =
                    self.new_entry(&turn.turn_id, EntryType::Unknown, !turn.is_replay());
                entry.text = Some(other.to_string());
                entry.raw = Some(update.clone());
                self.t_insert(&turn.target, entry);
            }
        }
    }

    /// Updates that belong to the task, not a turn. True when handled.
    fn handle_task_update(&self, update: &Value) -> bool {
        match update.get("sessionUpdate").and_then(Value::as_str) {
            Some("usage_update") => {
                self.record_usage_update(update);
                true
            }
            Some("tool_call" | "tool_call_update") => {
                self.upsert_tool_entry(update);
                true
            }
            Some("available_commands_update") => {
                let commands: Vec<AvailableCommand> = update
                    .get("availableCommands")
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(|c| serde_json::from_value(c.clone()).ok())
                            .collect()
                    })
                    .unwrap_or_default();
                self.sh
                    .db
                    .update_task(&self.id, |row| row.commands = Some(commands.clone()));
                self.announce_catalog(None, Some(commands));
                true
            }
            Some("current_mode_update" | "config_option_update") => true,
            _ => false,
        }
    }

    fn derive_locations(&self, raw_input: Option<&Value>) -> Option<Value> {
        let path = raw_input?.get("path")?.as_str()?;
        let abs = match resolve_workspace_path(Path::new(&self.workspace), path) {
            Ok((abs, _)) => abs.to_string_lossy().into_owned(),
            Err(_) => path.to_string(),
        };
        Some(json!([{"path": abs}]))
    }

    fn upsert_tool_entry(&self, update: &Value) {
        let tool_call_id = update
            .get("toolCallId")
            .and_then(Value::as_str)
            .map(str::to_string);
        let title = tool_call_title(self.adapter, update);
        let locations = update
            .get("locations")
            .filter(|l| !l.is_null())
            .cloned()
            .or_else(|| self.derive_locations(update.get("rawInput")));
        let (target, existing, turn_id) = {
            let mut st = self.st.borrow_mut();
            let st = &mut *st;
            let existing = tool_call_id
                .as_ref()
                .and_then(|id| st.tool_event_ids.get(id).cloned());
            let target = st
                .current_turn
                .as_ref()
                .map(|t| t.target.clone())
                .unwrap_or(Target::Live);
            if existing.is_none()
                && let Some(turn) = st.current_turn.as_mut()
            {
                self.close_run(turn);
            }
            let turn_id = st
                .current_turn
                .as_ref()
                .map(|t| t.turn_id.clone())
                .unwrap_or_default();
            (target, existing, turn_id)
        };
        let replay = matches!(target, Target::Stage(_));
        if let Some(entry_id) = existing {
            let found = self.t_update(&target, &entry_id, |e| {
                let mut merged = e.tool_call.clone().unwrap_or_else(|| json!({}));
                let previous_title = merged.get("title").cloned();
                let previous_locations = merged.get("locations").cloned();
                if let (Some(m), Some(u)) = (merged.as_object_mut(), update.as_object()) {
                    for (k, v) in u {
                        m.insert(k.clone(), v.clone());
                    }
                }
                merged["title"] = title
                    .clone()
                    .map(Value::String)
                    .or(previous_title)
                    .unwrap_or(Value::Null);
                merged["locations"] = locations
                    .clone()
                    .or(previous_locations)
                    .unwrap_or(Value::Null);
                e.tool_call = Some(merged);
            });
            // A late update whose row moved to the live store (replay committed).
            let entry = if found {
                self.t_get(&target, &entry_id)
            } else {
                None
            };
            if let Some(entry) = entry
                && let Some(tc) = entry.tool_call
            {
                self.announce_tool_call(&entry.turn_id, tc, replay);
            }
            return;
        }
        let mut tool_call = update.clone();
        tool_call["title"] = title.map(Value::String).unwrap_or(Value::Null);
        tool_call["locations"] = locations.unwrap_or(Value::Null);
        let mut entry = self.new_entry(&turn_id, EntryType::ToolCall, !replay);
        entry.tool_call_id = tool_call_id.clone();
        entry.tool_call = Some(tool_call.clone());
        if let Some(id) = tool_call_id {
            self.st
                .borrow_mut()
                .tool_event_ids
                .insert(id, entry.id.clone());
        }
        self.t_insert(&target, entry);
        self.announce_tool_call(&turn_id, tool_call, replay);
    }

    fn announce_tool_call(&self, turn_id: &str, tool_call: Value, replay: bool) {
        if turn_id.is_empty() || replay {
            return;
        }
        self.sh.announce(AgentEvent::ToolCall {
            task_id: self.id.clone(),
            turn_id: turn_id.into(),
            workspace_path: self.workspace.clone(),
            tool_call,
        });
    }

    fn announce_catalog(
        &self,
        config_options: Option<Vec<SessionConfigSelect>>,
        commands: Option<Vec<AvailableCommand>>,
    ) {
        self.sh.announce(AgentEvent::Catalog {
            task_id: self.id.clone(),
            harness_id: self.harness.id.clone(),
            workspace_path: self.workspace.clone(),
            config_options,
            commands,
        });
    }

    pub(crate) fn write_config_options(&self, options: &[SessionConfigSelect]) {
        let options = options.to_vec();
        self.sh
            .db
            .update_task(&self.id, |row| row.config_options = Some(options.clone()));
        self.announce_catalog(Some(options), None);
    }

    // ── usage ───────────────────────────────────────────────────────────

    fn record_usage_update(&self, update: &Value) {
        let replay = {
            let mut st = self.st.borrow_mut();
            if st.current_turn.is_some() {
                st.turn_usage_updates.push(update.clone());
            }
            st.current_turn.as_ref().is_some_and(|t| t.is_replay())
        };
        if !is_main_agent(self.adapter, update) {
            return;
        }
        self.st.borrow_mut().last_usage_update = Some(update.clone());
        if !replay && let Some(limits) = limits_from(self.adapter, update) {
            let key = serde_json::to_string(&limits).unwrap_or_default();
            let changed = self.st.borrow().last_limits_key.as_deref() != Some(&key);
            if changed {
                self.st.borrow_mut().last_limits_key = Some(key);
                self.sh.announce(AgentEvent::UsageLimits {
                    task_id: self.id.clone(),
                    harness_id: self.harness.id.clone(),
                    at: now_ms(),
                    limits,
                });
            }
        }
        let context = context_from(update);
        let Some(row) = self.sh.db.task(&self.id) else {
            return;
        };
        if row.usage.as_ref().and_then(|u| u.context) == Some(context) {
            return;
        }
        let mut next = row.usage.unwrap_or_default();
        next.context = Some(context);
        self.sh.db.update_task(&self.id, |r| r.usage = Some(next));
    }

    fn record_turn_usage(&self, turn_id: &str, response: Option<&Value>) {
        let row = self.sh.db.task(&self.id);
        let (updates, last, baseline) = {
            let mut st = self.st.borrow_mut();
            (
                std::mem::take(&mut st.turn_usage_updates),
                st.last_usage_update.clone(),
                st.cost_baseline,
            )
        };
        let baseline = baseline
            .or_else(|| {
                row.as_ref()?
                    .usage
                    .as_ref()?
                    .total
                    .cost
                    .as_ref()
                    .map(|c| c.amount)
            })
            .unwrap_or(0.0);
        let model = row.as_ref().and_then(|r| r.current_model());
        let reader: &dyn UsageReader = self.adapter;
        let n = normalize_turn_usage(
            reader,
            response,
            last.as_ref(),
            &updates,
            model.as_deref(),
            baseline,
        );
        if let Some(total) = n.cost_total {
            self.st.borrow_mut().cost_baseline = Some(total);
        }
        let usage = n.usage;
        self.sh
            .db
            .update_turn(turn_id, |t| t.usage = Some(usage.clone()));
        let Some(usage) = usage else { return };
        if let Some(row) = row {
            let next = row.usage.clone().unwrap_or_default().add_turn(&usage);
            self.sh.db.update_task(&self.id, |r| r.usage = Some(next));
        }
        self.sh.announce(AgentEvent::Usage {
            task_id: self.id.clone(),
            turn_id: turn_id.into(),
            workspace_path: self.workspace.clone(),
            harness_id: self.harness.id.clone(),
            at: now_ms(),
            usage,
        });
    }

    // ── prompts / queue ─────────────────────────────────────────────────

    pub(crate) fn record_queued_turn(&self, turn_id: &str, text: &str) {
        let now = now_ms();
        let mut entry = self.new_entry(turn_id, EntryType::User, true);
        entry.text = Some(text.to_string());
        self.sh.db.insert_entry(entry);
        self.sh.db.insert_turn(AgentTurn {
            turn_id: turn_id.into(),
            task_id: self.id.clone(),
            session_id: self.session_id().unwrap_or_default(),
            status: TurnStatus::Queued,
            stop_reason: None,
            error: None,
            started_at: now,
            usage: None,
        });
        self.sh.db.update_task(&self.id, |row| row.updated_at = now);
    }

    /// Send a prompt: recorded (user entry + queued turn) at once, run FIFO.
    pub fn prompt(
        &self,
        text: &str,
        extras: PromptExtras,
        front: bool,
    ) -> (String, async_channel::Receiver<TurnOutcome>) {
        let turn_id = new_turn_id();
        self.record_queued_turn(&turn_id, text);
        let rx = self.enqueue(
            QueuedPrompt {
                turn_id: turn_id.clone(),
                text: text.into(),
                extras,
            },
            front,
        );
        (turn_id, rx)
    }

    pub(crate) fn enqueue(
        &self,
        q: QueuedPrompt,
        front: bool,
    ) -> async_channel::Receiver<TurnOutcome> {
        let (tx, rx) = async_channel::bounded(1);
        self.st.borrow_mut().resolvers.insert(q.turn_id.clone(), tx);
        let (disposed, has_session, start_called) = {
            let st = self.st.borrow();
            (
                st.disposed,
                st.client.is_some() && st.session_id.is_some(),
                st.start_called,
            )
        };
        let spawning = start_called && self.current_status() == TaskStatus::Starting;
        if disposed {
            self.settle_queued_turn(&q.turn_id, TurnStatus::Cancelled, None);
            return rx;
        }
        if !has_session && !spawning {
            self.settle_queued_turn(
                &q.turn_id,
                TurnStatus::Error,
                Some("agent task is not started".into()),
            );
            return rx;
        }
        let kick = {
            let mut st = self.st.borrow_mut();
            if front {
                st.pending.push_front(q);
            } else {
                st.pending.push_back(q);
            }
            has_session && st.current_turn.is_none() && !st.draining && !st.auth_blocked
        };
        if kick {
            self.kick_drain();
        }
        rx
    }

    pub fn remove_queued_prompt(&self, turn_id: &str) {
        let removed = {
            let mut st = self.st.borrow_mut();
            let index = st.pending.iter().position(|p| p.turn_id == turn_id);
            index.and_then(|i| st.pending.remove(i))
        };
        if removed.is_none() {
            return;
        }
        for entry in self.sh.db.entries_for_task(&self.id) {
            if entry.turn_id == turn_id {
                self.sh.db.delete_entry(&self.id, &entry.id);
            }
        }
        self.sh.db.delete_turn(turn_id);
        self.resolve_turn(turn_id, TurnOutcome::Cancelled);
        self.announce_settled(turn_id, TurnStatus::Cancelled, now_ms());
    }

    fn settle_queued_turn(&self, turn_id: &str, status: TurnStatus, error: Option<String>) {
        self.sh.db.update_turn(turn_id, |t| {
            t.status = status;
            if error.is_some() {
                t.error = error.clone();
            }
        });
        self.resolve_turn(
            turn_id,
            match status {
                TurnStatus::Error => TurnOutcome::Error(error.unwrap_or_default()),
                _ => TurnOutcome::Cancelled,
            },
        );
        self.announce_settled(turn_id, status, now_ms());
    }

    fn announce_settled(&self, turn_id: &str, status: TurnStatus, at: i64) {
        self.sh.announce(AgentEvent::TurnSettled {
            task_id: self.id.clone(),
            turn_id: turn_id.into(),
            status,
            at,
        });
    }

    fn resolve_turn(&self, turn_id: &str, outcome: TurnOutcome) {
        if let Some(tx) = self.st.borrow_mut().resolvers.remove(turn_id) {
            let _ = tx.try_send(outcome);
        }
    }

    fn kick_drain(&self) {
        let me = self.rc();
        self.sh
            .spawner
            .spawn(async move { me.drain_queue().await })
            .detach();
    }

    async fn drain_queue(self: Rc<Self>) {
        {
            let mut st = self.st.borrow_mut();
            if st.draining {
                return;
            }
            st.draining = true;
        }
        loop {
            let next = {
                let mut st = self.st.borrow_mut();
                if st.disposed {
                    None
                } else {
                    st.pending.pop_front()
                }
            };
            let Some(next) = next else { break };
            if self.clone().run_turn(next).await == TurnStatus::Error {
                break;
            }
        }
        self.st.borrow_mut().draining = false;
    }

    async fn run_turn(self: Rc<Self>, q: QueuedPrompt) -> TurnStatus {
        let (client, session_id) = {
            let st = self.st.borrow();
            (st.client.clone(), st.session_id.clone())
        };
        let (Some(client), Some(session_id)) = (client, session_id) else {
            self.settle_queued_turn(
                &q.turn_id,
                TurnStatus::Error,
                Some("agent task is not started".into()),
            );
            return TurnStatus::Error;
        };
        let rename = self.st.borrow().title == NEW_TASK_TITLE;
        if rename {
            let title = title_from_prompt(&q.text);
            self.st.borrow_mut().title = title.clone();
            self.sh.db.update_task(&self.id, |row| row.title = title);
        }
        let sid = session_id.clone();
        self.sh.db.update_turn(&q.turn_id, |t| {
            t.status = TurnStatus::Running;
            t.session_id = sid;
        });
        {
            let mut st = self.st.borrow_mut();
            st.current_turn = Some(TurnState::new(
                q.turn_id.clone(),
                q.text.clone(),
                Target::Live,
            ));
            st.turn_usage_updates.clear();
        }
        self.set_status(TaskStatus::Running);

        let Some(blocks) = self.clone().prompt_blocks(&q, &client).await else {
            return self
                .sh
                .db
                .turn(&q.turn_id)
                .map(|t| t.status)
                .unwrap_or(TurnStatus::Cancelled);
        };
        match client.prompt(&session_id, blocks).await {
            Ok(response) => {
                self.clear_auth_block();
                self.mark_signed_in();
                let still_ours = self
                    .st
                    .borrow()
                    .current_turn
                    .as_ref()
                    .is_some_and(|t| t.turn_id == q.turn_id);
                // Usage lands before the turn settles, so whoever sees the
                // settle (another thread) sees what it spent.
                self.record_turn_usage(&q.turn_id, Some(&response));
                if still_ours {
                    let stop = response
                        .get("stopReason")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    self.finish_turn(stop, TurnStatus::Completed, None)
                } else {
                    TurnStatus::Cancelled
                }
            }
            Err(e) => {
                let message = e.to_string();
                if needs_sign_in(self.adapter, &message) {
                    self.enter_auth_block(q.clone());
                }
                self.warn("turn error", &message);
                self.record_turn_usage(&q.turn_id, None);
                self.finish_turn(None, TurnStatus::Error, Some(message))
            }
        }
    }

    fn mark_signed_in(&self) {
        let first = !std::mem::replace(&mut self.st.borrow_mut().signed_in_marked, true);
        if first {
            self.sh.db.kv_set(
                &format!("agent/auth:{}", self.harness.id),
                Value::Bool(true),
            );
        }
    }

    async fn prompt_blocks(
        self: Rc<Self>,
        q: &QueuedPrompt,
        client: &Rc<AcpClient>,
    ) -> Option<Vec<Value>> {
        self.clone().switch_settings(&q.extras.config).await;
        let ours = {
            let st = self.st.borrow();
            !st.disposed
                && st
                    .current_turn
                    .as_ref()
                    .is_some_and(|t| t.turn_id == q.turn_id)
        };
        if !ours {
            return None;
        }
        let blocks = compose_prompt(&q.text, &q.extras.context_parts, client.embedded_context());
        let adapter = self.adapter;
        let placer = move |blocks: Vec<Value>, name: &str| {
            adapter
                .place_command(blocks.clone(), name)
                .unwrap_or_else(|| {
                    notefig_agent::prompt::with_first_text(blocks, |t| format!("/{name} {t}"))
                })
        };
        Some(place_commands(blocks, &q.extras.commands, Some(&placer)))
    }

    async fn switch_settings(self: Rc<Self>, changes: &[notefig_agent::prompt::PromptConfigChange]) {
        for change in changes {
            let option = self
                .sh
                .db
                .task(&self.id)
                .and_then(|r| r.config_options)
                .and_then(|o| {
                    o.into_iter()
                        .find(|o| o.category.as_deref() == Some(change.category.as_str()))
                });
            let Some(option) = option else { continue };
            if option.current() == Some(change.value.as_str()) {
                continue;
            }
            if !option.choices().iter().any(|c| c.value == change.value) {
                self.warn(
                    "setting not offered",
                    &format!("{}={}", change.category, change.value),
                );
                continue;
            }
            if let Err(e) = self
                .clone()
                .set_config_option(option.id.clone(), change.value.clone())
                .await
            {
                self.warn("setting switch failed", &e);
            }
        }
    }

    pub async fn set_config_option(
        self: Rc<Self>,
        option_id: String,
        value: String,
    ) -> Result<(), String> {
        let (client, session_id) = {
            let st = self.st.borrow();
            (st.client.clone(), st.session_id.clone())
        };
        let (Some(client), Some(session_id)) = (client, session_id) else {
            return Err("agent session is not ready".into());
        };
        client
            .set_session_config_option(&session_id, &option_id, &value)
            .await
            .map(|_| ())
            .map_err(error_message)
    }

    fn finish_turn(
        &self,
        stop_reason: Option<String>,
        status: TurnStatus,
        error: Option<String>,
    ) -> TurnStatus {
        let Some(mut turn) = self.st.borrow_mut().current_turn.take() else {
            return status;
        };
        self.close_run(&mut turn);
        self.resolve_lingering_tool_calls(&turn.target, &turn.turn_id, status);
        let (stop, err) = (stop_reason.clone(), error.clone());
        self.sh.db.update_turn(&turn.turn_id, |t| {
            t.status = status;
            t.stop_reason = stop;
            if err.is_some() {
                t.error = err;
            }
        });
        let at = now_ms();
        if matches!(status, TurnStatus::Completed | TurnStatus::Error) {
            let settled = LastSettled {
                turn_id: turn.turn_id.clone(),
                at,
                status,
            };
            self.sh
                .db
                .update_task(&self.id, |row| row.last_settled = Some(settled));
        }
        self.announce_settled(&turn.turn_id, status, at);
        self.resolve_turn(
            &turn.turn_id,
            match status {
                TurnStatus::Error => {
                    TurnOutcome::Error(error.unwrap_or_else(|| "unknown error".into()))
                }
                TurnStatus::Cancelled => TurnOutcome::Cancelled,
                _ => TurnOutcome::Completed { stop_reason },
            },
        );
        self.set_status(if status == TurnStatus::Error {
            TaskStatus::Error
        } else {
            TaskStatus::Idle
        });
        if status == TurnStatus::Completed {
            self.sh.announce(AgentEvent::TurnCompleted {
                task_id: self.id.clone(),
                turn_id: turn.turn_id.clone(),
                workspace_path: self.workspace.clone(),
                prompt: turn.user_text.clone(),
                harness_id: self.harness.id.clone(),
            });
        }
        status
    }

    // ── auth ────────────────────────────────────────────────────────────

    fn enter_auth_block(&self, held: QueuedPrompt) {
        let (hint, methods) = {
            let mut st = self.st.borrow_mut();
            st.auth_blocked = true;
            st.held = Some(held);
            let client = st.client.clone();
            (
                client
                    .as_ref()
                    .and_then(|c| c.auth_hint())
                    .or_else(|| self.harness.auth_hint.clone()),
                client.map(|c| c.auth_methods()).unwrap_or_default(),
            )
        };
        self.sh.db.update_task(&self.id, |row| {
            row.auth_required = true;
            row.auth_methods = methods;
            row.auth_hint = hint;
        });
    }

    fn clear_auth_block(&self) {
        let was = std::mem::replace(&mut self.st.borrow_mut().auth_blocked, false);
        let row_says = self
            .sh
            .db
            .task(&self.id)
            .is_some_and(|r| r.auth_required || r.auth_hint.is_some());
        if was || row_says {
            self.sh.db.update_task(&self.id, |row| {
                row.auth_required = false;
                row.auth_hint = None;
            });
        }
    }

    pub async fn authenticate(self: Rc<Self>, method_id: String) -> Result<(), String> {
        let client = self
            .st
            .borrow()
            .client
            .clone()
            .ok_or("agent task is not started")?;
        client
            .authenticate(&method_id)
            .await
            .map_err(error_message)?;
        self.retry_held_prompt();
        Ok(())
    }

    /// "I've signed in": clear the block and re-send the held prompt first.
    pub fn retry_held_prompt(&self) {
        let held = self.st.borrow_mut().held.take();
        self.clear_auth_block();
        if self.current_status() == TaskStatus::Error {
            self.set_status(TaskStatus::Idle);
        }
        if let Some(held) = held {
            let requeued = self.sh.db.update_turn(&held.turn_id, |t| {
                t.status = TurnStatus::Queued;
                t.error = None;
                t.stop_reason = None;
            });
            if requeued {
                self.sh.announce(AgentEvent::TurnRequeued {
                    task_id: self.id.clone(),
                    turn_id: held.turn_id.clone(),
                });
            }
            let kick = {
                let mut st = self.st.borrow_mut();
                st.pending.push_front(held);
                st.current_turn.is_none() && !st.draining
            };
            if kick {
                self.kick_drain();
            }
        } else {
            let kick = {
                let st = self.st.borrow();
                !st.pending.is_empty() && st.current_turn.is_none() && !st.draining
            };
            if kick {
                self.kick_drain();
            }
        }
    }

    // ── permissions ─────────────────────────────────────────────────────

    pub(crate) fn request_permission(&self, params: Value) -> LocalBoxFuture<Value> {
        let (tx, rx) = async_channel::bounded(1);
        let id = {
            let mut st = self.st.borrow_mut();
            st.next_permission += 1;
            let id = format!("{}_perm_{}", self.id, st.next_permission);
            st.permissions.insert(id.clone(), tx);
            id
        };
        let tool_call = params.get("toolCall").cloned();
        let options: Vec<PermissionOption> = params
            .get("options")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|o| serde_json::from_value(o.clone()).ok())
                    .collect()
            })
            .unwrap_or_default();
        self.sh.db.upsert_permission(PermissionRequestRow {
            id,
            task_id: self.id.clone(),
            session_id: params
                .get("sessionId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .into(),
            title: tool_call
                .as_ref()
                .and_then(|t| t.get("title"))
                .and_then(Value::as_str)
                .unwrap_or("The agent is requesting permission")
                .into(),
            options,
            tool_call,
            status: PermissionStatus::Pending,
        });
        Box::pin(async move {
            rx.recv()
                .await
                .unwrap_or(PermissionOutcome::Cancelled)
                .to_json()
        })
    }

    pub fn respond_permission(&self, request_id: &str, outcome: PermissionOutcome) -> bool {
        let Some(tx) = self.st.borrow_mut().permissions.remove(request_id) else {
            return false;
        };
        let _ = tx.try_send(outcome.clone());
        self.settle_permission_row(request_id, &outcome);
        true
    }

    fn cancel_all_permissions(&self) {
        let pending: Vec<(String, async_channel::Sender<PermissionOutcome>)> =
            self.st.borrow_mut().permissions.drain().collect();
        for (id, tx) in pending {
            let _ = tx.try_send(PermissionOutcome::Cancelled);
            self.settle_permission_row(&id, &PermissionOutcome::Cancelled);
        }
    }

    fn settle_permission_row(&self, id: &str, outcome: &PermissionOutcome) {
        let row = self.sh.db.lock().permissions.get(id).cloned();
        if let Some(mut row) = row {
            row.status = match outcome {
                PermissionOutcome::Cancelled => PermissionStatus::Cancelled,
                PermissionOutcome::Selected(option) => {
                    let kind = row
                        .options
                        .iter()
                        .find(|o| &o.option_id == option)
                        .map(|o| o.kind.as_str());
                    if kind.is_some_and(|k| k.starts_with("reject")) {
                        PermissionStatus::Denied
                    } else {
                        PermissionStatus::Granted
                    }
                }
            };
            self.sh.db.upsert_permission(row);
        }
    }

    // ── cancel / refresh / dispose ──────────────────────────────────────

    pub fn cancel(&self) {
        self.cancel_all_permissions();
        let pending: Vec<QueuedPrompt> = self.st.borrow_mut().pending.drain(..).collect();
        for q in pending {
            self.settle_queued_turn(&q.turn_id, TurnStatus::Cancelled, None);
        }
        let (client, session_id, active) = {
            let st = self.st.borrow();
            (
                st.client.clone(),
                st.session_id.clone(),
                st.current_turn.as_ref().map(|t| !t.is_replay()),
            )
        };
        if let (Some(client), Some(session_id), Some(true)) = (client, session_id, active) {
            client.cancel(&session_id);
            self.finish_turn(Some("cancelled".into()), TurnStatus::Cancelled, None);
            self.set_status(TaskStatus::Cancelled);
        }
    }

    /// Cancel; if the agent hadn't responded yet, forget the turn's rows
    /// (the prompt goes back to the composer). True when forgotten.
    pub fn cancel_and_forget(&self) -> bool {
        let turn_id = self
            .st
            .borrow()
            .current_turn
            .as_ref()
            .map(|t| t.turn_id.clone());
        self.cancel();
        let Some(turn_id) = turn_id else { return false };
        let entries: Vec<AgentEntry> = self
            .sh
            .db
            .entries_for_task(&self.id)
            .into_iter()
            .filter(|e| e.turn_id == turn_id)
            .collect();
        if entries.iter().any(|e| e.kind != EntryType::User) {
            return false;
        }
        for e in entries {
            self.sh.db.delete_entry(&self.id, &e.id);
        }
        self.sh.db.delete_turn(&turn_id);
        true
    }

    /// Re-sync from the harness's own store (session/close + session/load).
    pub async fn refresh_from_harness(self: Rc<Self>) -> Result<(), String> {
        let (session_id, busy, connected) = {
            let st = self.st.borrow();
            (
                st.session_id.clone(),
                st.current_turn.is_some() || st.draining,
                st.client.is_some(),
            )
        };
        let Some(session_id) = session_id.filter(|_| connected) else {
            return Err("agent task is not started".into());
        };
        if busy {
            return Err("a turn is in progress".into());
        }
        self.set_status(TaskStatus::Starting);
        let mcp = self.current_mcp_servers();
        let result = match with_timeout(
            self.sh.startup_timeout,
            self.clone().resume_session(session_id, mcp, true),
        )
        .await
        {
            Some(Ok(())) => {
                self.set_status(TaskStatus::Idle);
                Ok(())
            }
            Some(Err(e)) => Err(e),
            None => Err("agent startup timed out (session/load)".into()),
        };
        match &result {
            Ok(()) => {
                let kick = {
                    let st = self.st.borrow();
                    !st.pending.is_empty()
                        && !st.auth_blocked
                        && st.current_turn.is_none()
                        && !st.draining
                };
                if kick {
                    self.kick_drain();
                }
            }
            Err(e) => {
                self.warn("session refresh failed", e);
                self.set_status(TaskStatus::Error);
            }
        }
        result
    }

    pub fn dispose(&self) {
        self.st.borrow_mut().disposed = true;
        let pending: Vec<QueuedPrompt> = self.st.borrow_mut().pending.drain(..).collect();
        for q in pending {
            self.settle_queued_turn(&q.turn_id, TurnStatus::Cancelled, None);
        }
        self.cancel();
        self.teardown();
        self.finish_start(Err("agent task was disposed".into()));
    }

    pub fn services(&self) -> Arc<dyn ClientServices> {
        self.sh.services.clone()
    }
}

// ── ACP delegate ────────────────────────────────────────────────────────

struct TaskDelegate(Weak<Task>);

impl AcpDelegate for TaskDelegate {
    fn session_update(&self, params: &Value) {
        if let Some(task) = self.0.upgrade() {
            task.handle_notification(params);
        }
    }

    fn config_changed(&self, _session_id: &str, options: &[SessionConfigSelect]) {
        if let Some(task) = self.0.upgrade() {
            task.write_config_options(options);
        }
    }

    fn request_permission(&self, params: Value) -> LocalBoxFuture<Value> {
        match self.0.upgrade() {
            Some(task) => task.request_permission(params),
            None => Box::pin(async { PermissionOutcome::Cancelled.to_json() }),
        }
    }

    fn read_text_file(
        &self,
        path: String,
        line: Option<u64>,
        limit: Option<u64>,
    ) -> LocalBoxFuture<Result<String, String>> {
        let task = self.0.upgrade();
        Box::pin(async move {
            let task = task.ok_or("agent task is gone")?;
            let (abs, _) = resolve_workspace_path(Path::new(&task.workspace), &path)?;
            let (reply, rx) = reply_pair();
            task.services().handle(ClientRequest::ReadTextFile {
                task_id: task.id.clone(),
                workspace_path: PathBuf::from(&task.workspace),
                path: abs,
                line,
                limit,
                reply,
            });
            rx.recv()
                .await
                .unwrap_or_else(|_| Err("the app dropped the request".into()))
        })
    }

    fn write_text_file(&self, path: String, content: String) -> LocalBoxFuture<Result<(), String>> {
        let task = self.0.upgrade();
        Box::pin(async move {
            let task = task.ok_or("agent task is gone")?;
            let (abs, _) = resolve_workspace_path(Path::new(&task.workspace), &path)?;
            let (reply, rx) = reply_pair();
            task.services().handle(ClientRequest::WriteTextFile {
                task_id: task.id.clone(),
                workspace_path: PathBuf::from(&task.workspace),
                path: abs,
                content,
                reply,
            });
            rx.recv()
                .await
                .unwrap_or_else(|_| Err("the app dropped the request".into()))
        })
    }
}

// ── MCP host ────────────────────────────────────────────────────────────

struct TaskMcpHost(Weak<Task>);

impl McpHost for TaskMcpHost {
    fn task_id(&self) -> String {
        self.0.upgrade().map(|t| t.id.clone()).unwrap_or_default()
    }
    fn workspace_path(&self) -> PathBuf {
        self.0
            .upgrade()
            .map(|t| PathBuf::from(&t.workspace))
            .unwrap_or_default()
    }
    fn services(&self) -> Arc<dyn ClientServices> {
        match self.0.upgrade() {
            Some(t) => t.services(),
            None => Arc::new(notefig_agent::services::DiskServices),
        }
    }
    fn request_permission(&self, title: String) -> LocalBoxFuture<bool> {
        let Some(task) = self.0.upgrade() else {
            return Box::pin(async { false });
        };
        let params = json!({
            "sessionId": task.id,
            "toolCall": {"toolCallId": new_event_id(), "title": title},
            "options": [
                {"optionId": "allow", "name": "Allow", "kind": "allow_once"},
                {"optionId": "deny", "name": "Deny", "kind": "reject_once"},
            ],
        });
        let fut = task.request_permission(params);
        Box::pin(async move {
            let response = fut.await;
            response
                .pointer("/outcome/optionId")
                .and_then(Value::as_str)
                == Some("allow")
        })
    }
    fn on_request(&self, method: &str, detail: &str) {
        if let Some(task) = self.0.upgrade() {
            task.warn(&format!("mcp {method}"), detail);
        }
    }
}
