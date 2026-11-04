#![allow(dead_code)]
//! The task runtime over an in-process fake ACP agent (a std thread on a
//! loopback socket, plugged in through `TransportFactory`): update
//! handling, queue, auth hold/retry, permissions, cancel, fs delegation,
//! revival with replay, config switching.

use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::runtime::host::{AgentHandle, AgentHost, HostConfig, Pending};
use crate::runtime::events::AgentEvent;
use crate::runtime::host::StartResult;
use crate::runtime::store::{MemoryStore, PersistedState};
use notefig_agent::process::{ProcError, SpawnSpec, Transport, TransportFactory, with_timeout};
use notefig_agent::prompt::{PromptCommand, PromptConfigChange};
use notefig_agent::*;
use notefig_agent::services::DiskServices;
use serde_json::{Value, json};

// ── fake agent ──────────────────────────────────────────────────────────

#[derive(Default)]
struct FakeState {
    auth_failures_left: AtomicUsize,
    /// Every message the agent received.
    log: Mutex<Vec<Value>>,
}

struct Fake {
    reader: BufReader<TcpStream>,
    writer: TcpStream,
    next_id: i64,
    state: Arc<FakeState>,
    session: String,
    config_value: String,
}

impl Fake {
    fn send(&mut self, v: Value) {
        let _ = writeln!(self.writer, "{v}");
    }
    fn read(&mut self) -> Option<Value> {
        loop {
            let mut line = String::new();
            if self.reader.read_line(&mut line).ok()? == 0 {
                return None;
            }
            if line.trim().is_empty() {
                continue;
            }
            let v: Value = serde_json::from_str(&line).ok()?;
            self.state.log.lock().unwrap().push(v.clone());
            return Some(v);
        }
    }
    fn update(&mut self, update: Value) {
        let sid = self.session.clone();
        self.send(json!({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": sid, "update": update}}));
    }
    fn chunk(&mut self, kind: &str, text: &str) {
        self.update(json!({"sessionUpdate": kind, "content": {"type": "text", "text": text}}));
    }
    /// A client request; reads until its response.
    fn call(&mut self, method: &str, params: Value) -> Value {
        self.next_id += 1;
        let id = 1000 + self.next_id;
        self.send(json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}));
        while let Some(msg) = self.read() {
            if msg.get("id") == Some(&json!(id)) && msg.get("method").is_none() {
                return msg;
            }
        }
        Value::Null
    }
    fn respond(&mut self, id: &Value, result: Value) {
        self.send(json!({"jsonrpc": "2.0", "id": id, "result": result}));
    }
    fn config_options(&self) -> Value {
        json!([{"id": "model", "name": "Model", "category": "model", "type": "select", "currentValue": self.config_value,
                "options": [{"value": "a", "name": "A"}, {"value": "b", "name": "B"}]}])
    }

    fn run(mut self) {
        while let Some(msg) = self.read() {
            let Some(method) = msg
                .get("method")
                .and_then(Value::as_str)
                .map(str::to_string)
            else {
                continue;
            };
            let id = msg.get("id").cloned().unwrap_or(Value::Null);
            let params = msg.get("params").cloned().unwrap_or(Value::Null);
            match method.as_str() {
                "initialize" => self.respond(&id, json!({
                    "protocolVersion": 1,
                    "agentCapabilities": {"loadSession": true, "promptCapabilities": {"embeddedContext": true}, "sessionCapabilities": {"delete": {}}},
                    "authMethods": [{"id": "login", "name": "Log in", "description": "Run `fake login` in a terminal."}],
                })),
                "session/new" => {
                    self.session = "s1".into();
                    let opts = self.config_options();
                    self.respond(&id, json!({"sessionId": "s1", "configOptions": opts}));
                    self.update(json!({"sessionUpdate": "available_commands_update", "availableCommands": [{"name": "review", "description": "Review"}]}));
                }
                "session/load" => {
                    self.session = params["sessionId"].as_str().unwrap_or("").into();
                    self.chunk("user_message_chunk", "old prompt");
                    self.chunk("agent_message_chunk", "old answer");
                    self.update(json!({"sessionUpdate": "tool_call", "toolCallId": "t0", "title": "Read", "kind": "read", "status": "in_progress"}));
                    let opts = self.config_options();
                    self.respond(&id, json!({"configOptions": opts}));
                }
                "session/set_config_option" => {
                    self.config_value = params["value"].as_str().unwrap_or("").into();
                    let opts = self.config_options();
                    self.respond(&id, json!({"configOptions": opts}));
                }
                "authenticate" => {
                    self.state.auth_failures_left.store(0, Ordering::SeqCst);
                    self.respond(&id, json!({}));
                }
                "session/close" | "session/delete" => self.respond(&id, json!({})),
                "session/prompt" => self.prompt(id, params),
                _ => {
                    if !id.is_null() {
                        self.send(json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": "nope"}}));
                    }
                }
            }
        }
    }

    fn prompt(&mut self, id: Value, params: Value) {
        let text = params["prompt"][0]["text"]
            .as_str()
            .unwrap_or("")
            .to_string();
        if text.contains("auth") && self.state.auth_failures_left.load(Ordering::SeqCst) > 0 {
            self.state.auth_failures_left.fetch_sub(1, Ordering::SeqCst);
            self.send(json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32000, "message": "Authentication required"}}));
            return;
        }
        if text.contains("perm-reject") || text.contains("perm-allow") {
            let options = if text.contains("perm-reject") {
                json!([{"optionId": "no", "name": "No", "kind": "reject_once"}])
            } else {
                json!([{"optionId": "once", "name": "Once", "kind": "allow_once"}, {"optionId": "always", "name": "Always", "kind": "allow_always"}, {"optionId": "no", "name": "No", "kind": "reject_once"}])
            };
            let sid = self.session.clone();
            let r = self.call("session/request_permission", json!({"sessionId": sid, "toolCall": {"toolCallId": "p1", "title": "Run rm"}, "options": options}));
            let picked = r
                .pointer("/result/outcome/optionId")
                .and_then(Value::as_str)
                .unwrap_or("cancelled")
                .to_string();
            self.chunk("agent_message_chunk", &format!("perm:{picked}"));
        } else if text.contains("write") {
            let sid = self.session.clone();
            let ok = self.call(
                "fs/write_text_file",
                json!({"sessionId": sid, "path": "out.md", "content": "hello"}),
            );
            let bad = self.call(
                "fs/write_text_file",
                json!({"sessionId": sid, "path": "../escape.md", "content": "x"}),
            );
            let read = self.call(
                "fs/read_text_file",
                json!({"sessionId": sid, "path": "out.md"}),
            );
            let summary = format!(
                "write:{} escape:{} read:{}",
                ok.get("result").is_some(),
                bad.get("error").is_some(),
                read.pointer("/result/content")
                    .and_then(Value::as_str)
                    .unwrap_or("?")
            );
            self.chunk("agent_message_chunk", &summary);
        } else if text.contains("slow") {
            while let Some(msg) = self.read() {
                if msg.get("method").and_then(Value::as_str) == Some("session/cancel") {
                    break;
                }
            }
            self.chunk("agent_message_chunk", "late");
            self.respond(&id, json!({"stopReason": "cancelled"}));
            return;
        } else if text.contains("echo") {
            let blocks = params["prompt"].to_string();
            self.chunk("agent_message_chunk", &blocks);
        } else {
            self.chunk("agent_thought_chunk", "thinking ");
            self.chunk("agent_thought_chunk", "more");
            self.chunk("agent_message_chunk", "Hello ");
            self.chunk("agent_message_chunk", "**bo");
            self.chunk("agent_message_chunk", "ld**");
            self.chunk("agent_message_chunk", " world");
            self.update(json!({"sessionUpdate": "tool_call", "toolCallId": "t1", "title": "mcp__notefig__workspace_read_document", "kind": "read", "status": "pending", "rawInput": {"path": "a.md"}}));
            self.update(json!({"sessionUpdate": "plan", "entries": [{"content": "one", "priority": "high", "status": "pending"}]}));
            self.update(json!({"sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "completed"}));
            self.update(json!({"sessionUpdate": "plan", "entries": [{"content": "one", "priority": "high", "status": "completed"}, {"content": "two", "priority": "low", "status": "pending"}]}));
            self.update(json!({"sessionUpdate": "usage_update", "used": 10, "size": 100, "cost": {"amount": 0.5, "currency": "USD"}}));
            self.chunk("agent_message_chunk", "\n\n");
            self.update(json!({"sessionUpdate": "tool_call", "toolCallId": "t2", "title": "Edit", "kind": "edit", "status": "in_progress"}));
            self.chunk("agent_message_chunk", "after tool");
            self.update(json!({"sessionUpdate": "weird_update", "x": 1}));
        }
        self.respond(&id, json!({"stopReason": "end_turn", "usage": {"inputTokens": 10, "outputTokens": 5, "cachedReadTokens": 2}}));
    }
}

struct FakeTransport(Arc<FakeState>);

impl TransportFactory for FakeTransport {
    fn open(
        &self,
        _spec: SpawnSpec,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Transport, ProcError>>>> {
        let state = self.0.clone();
        Box::pin(async move {
            let listener = smol::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            std::thread::spawn(move || {
                let stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
                let fake = Fake {
                    reader: BufReader::new(stream.try_clone().unwrap()),
                    writer: stream,
                    next_id: 0,
                    state,
                    session: String::new(),
                    config_value: "a".into(),
                };
                fake.run();
            });
            let (stream, _) = listener.accept().await.unwrap();
            Ok(Transport {
                reader: Box::new(stream.clone()),
                writer: Box::new(stream),
                stderr: None,
                guard: None,
                exit: None,
            })
        })
    }
}

// ── harness for tests ───────────────────────────────────────────────────

struct Env {
    handle: AgentHandle,
    events: async_channel::Receiver<AgentEvent>,
    state: Arc<FakeState>,
    store: MemoryStore,
    ws: String,
    _dir: tempfile::TempDir,
}

fn persisted_with_fake_harness() -> PersistedState {
    let mut p = PersistedState::default();
    p.harnesses.insert(
        "fake".into(),
        json!({"id": "fake", "createdAt": 1, "custom": {"id": "fake", "label": "Fake", "command": "fake-agent", "mcpRegistrationOverride": "session-new", "resumeCommand": "cd ${workspace} && fake --resume ${sessionId}"}}),
    );
    p
}

fn boot(store: MemoryStore, dir: tempfile::TempDir, state: Arc<FakeState>) -> Env {
    let ws = dir
        .path()
        .canonicalize()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let mut config = HostConfig::new(store.clone(), Arc::new(DiskServices));
    config.discover_on_boot = false;
    config.probe_catalogs = false;
    config.startup_timeout = Duration::from_secs(5);
    config.transport = Arc::new(FakeTransport(state.clone()));
    let (handle, events) = AgentHost::start(config);
    handle.trust(&ws);
    Env {
        handle,
        events,
        state,
        store,
        ws,
        _dir: dir,
    }
}

fn env() -> Env {
    let store = MemoryStore::default();
    *store.0.lock().unwrap() = persisted_with_fake_harness();
    boot(store, tempfile::tempdir().unwrap(), Arc::default())
}

fn wait<T>(p: Pending<T>) -> T {
    smol::block_on(with_timeout(Duration::from_secs(10), p.recv()))
        .expect("timed out")
        .expect("reply")
}

fn started(env: &Env) -> String {
    let StartResult::Started { task_id } = wait(env.handle.start_task(&env.ws, "fake")) else {
        panic!("not started")
    };
    wait(env.handle.when_started(&task_id)).expect("session up");
    task_id
}

fn prompt(env: &Env, task: &str, text: &str, extras: PromptExtras) -> TurnOutcome {
    let h = wait(env.handle.prompt(task, text, extras));
    wait(h.completed)
}

fn texts(env: &Env, task: &str) -> Vec<(EntryType, String)> {
    env.handle
        .entries(task)
        .into_iter()
        .map(|e| (e.kind, e.text.unwrap_or_default()))
        .collect()
}

// ── tests ───────────────────────────────────────────────────────────────

#[test]
fn needs_trust_before_first_session() {
    let store = MemoryStore::default();
    *store.0.lock().unwrap() = persisted_with_fake_harness();
    let dir = tempfile::tempdir().unwrap();
    let ws = dir.path().to_string_lossy().into_owned();
    let mut config = HostConfig::new(store, Arc::new(DiskServices));
    config.discover_on_boot = false;
    config.probe_catalogs = false;
    let (handle, _events) = AgentHost::start(config);
    assert_eq!(
        wait(handle.start_task(&ws, "fake")),
        StartResult::NeedsTrust
    );
    handle.trust(&ws);
    assert!(matches!(
        wait(handle.start_task(&ws, "fake")),
        StartResult::Started { .. }
    ));
    assert_eq!(
        wait(handle.start_task(&ws, "nope")),
        StartResult::UnknownHarness
    );
}

#[test]
fn session_update_handling_builds_the_transcript() {
    let env = env();
    let task = started(&env);
    let row = env.handle.task(&task).unwrap();
    assert_eq!(row.status, TaskStatus::Idle);
    assert_eq!(row.session_id.as_deref(), Some("s1"));
    assert_eq!(row.config_options.as_ref().unwrap()[0].current(), Some("a"));

    let outcome = prompt(&env, &task, "go", PromptExtras::default());
    assert_eq!(
        outcome,
        TurnOutcome::Completed {
            stop_reason: Some("end_turn".into())
        }
    );
    let entries = env.handle.entries(&task);
    let kinds: Vec<EntryType> = entries.iter().map(|e| e.kind).collect();
    assert_eq!(
        kinds,
        vec![
            EntryType::User,
            EntryType::Thought,
            EntryType::Assistant,
            EntryType::ToolCall,
            EntryType::Plan,
            EntryType::ToolCall,
            EntryType::Assistant,
            EntryType::Unknown
        ]
    );
    assert_eq!(entries[1].text.as_deref(), Some("thinking more"));
    assert_eq!(entries[2].text.as_deref(), Some("Hello **bold** world"));
    // Tool calls coalesce by id; the MCP prefix is stripped; locations come from rawInput.path.
    let t1 = entries[3].tool_call_view().unwrap();
    assert_eq!(t1.title.as_deref(), Some("workspace_read_document"));
    assert_eq!(t1.status.as_deref(), Some("completed"));
    assert_eq!(t1.locations, vec![format!("{}/a.md", env.ws)]);
    // One plan per turn, replaced wholesale.
    assert_eq!(entries[4].plan_view().unwrap().entries.len(), 2);
    // A tool still in progress at turn end is swept to completed.
    assert_eq!(
        entries[5].tool_call_view().unwrap().status.as_deref(),
        Some("completed")
    );
    // The whitespace-only run before the tool was dropped.
    assert_eq!(entries[6].text.as_deref(), Some("after tool"));
    assert_eq!(entries[7].text.as_deref(), Some("weird_update"));
    assert!(entries[7].raw.is_some());

    let row = env.handle.task(&task).unwrap();
    assert_eq!(row.title, "go");
    assert_eq!(row.commands.as_ref().unwrap()[0].name, "review");
    let usage = row.usage.unwrap();
    assert_eq!(usage.turns, 1);
    assert_eq!(usage.total.tokens.input, 10.0);
    assert_eq!(usage.total.tokens.cache_read, 2.0);
    assert_eq!(usage.total.cost.unwrap().amount, 0.5);
    assert_eq!(usage.context.unwrap().size, 100.0);
    assert_eq!(row.last_settled.unwrap().status, TurnStatus::Completed);
    let turns = env.handle.turns(&task);
    assert_eq!(turns.len(), 1);
    assert!(turns[0].usage.clone().unwrap().is_some());
    assert_eq!(env.handle.usage_buckets().len(), 1);
    // Hook events fired.
    let events: Vec<AgentEvent> = std::iter::from_fn(|| env.events.try_recv().ok()).collect();
    assert!(
        events
            .iter()
            .any(|e| matches!(e, AgentEvent::TurnCompleted { prompt, .. } if prompt == "go"))
    );
    assert!(
        events
            .iter()
            .any(|e| matches!(e, AgentEvent::ToolCall { .. }))
    );
    assert!(events.iter().any(|e| matches!(e, AgentEvent::Usage { .. })));
    // The resume command renders with the session id.
    assert_eq!(
        env.handle
            .resume_command(&task, notefig_agent::harness::ResumeShellDialect::Posix)
            .unwrap(),
        format!("cd {} && fake --resume s1", env.ws)
    );
}

#[test]
fn prompts_queue_fifo() {
    let env = env();
    let task = started(&env);
    let a = wait(
        env.handle
            .prompt(&task, "first echo", PromptExtras::default()),
    );
    let b = wait(
        env.handle
            .prompt(&task, "second echo", PromptExtras::default()),
    );
    let c = wait(
        env.handle
            .prompt(&task, "third echo", PromptExtras::default()),
    );
    // All three rows exist from the moment of send.
    assert_eq!(env.handle.turns(&task).len(), 3);
    for h in [a, b, c] {
        assert!(matches!(wait(h.completed), TurnOutcome::Completed { .. }));
    }
    let users: Vec<String> = texts(&env, &task)
        .into_iter()
        .filter(|(k, _)| *k == EntryType::User)
        .map(|(_, t)| t)
        .collect();
    assert_eq!(users, vec!["first echo", "second echo", "third echo"]);
    let prompts: Vec<String> = env
        .state
        .log
        .lock()
        .unwrap()
        .iter()
        .filter(|m| m["method"] == "session/prompt")
        .map(|m| {
            m["params"]["prompt"][0]["text"]
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect();
    assert_eq!(prompts, vec!["first echo", "second echo", "third echo"]);
}

#[test]
fn auth_error_holds_the_prompt_until_retry() {
    let env = env();
    env.state.auth_failures_left.store(1, Ordering::SeqCst);
    let task = started(&env);
    let held = wait(
        env.handle
            .prompt(&task, "auth please", PromptExtras::default()),
    );
    assert!(
        matches!(wait(held.completed), TurnOutcome::Error(e) if e.contains("Authentication required"))
    );
    let row = env.handle.task(&task).unwrap();
    assert!(row.auth_required);
    assert_eq!(row.auth_methods[0].id, "login");
    assert_eq!(
        row.auth_hint.as_deref(),
        Some("Run `fake login` in a terminal.")
    );
    // A new prompt queues but doesn't drain while blocked.
    let queued = wait(
        env.handle
            .prompt(&task, "queued echo", PromptExtras::default()),
    );
    wait(env.handle.sync());
    assert_eq!(
        env.handle
            .turns(&task)
            .iter()
            .find(|t| t.turn_id == queued.turn_id)
            .unwrap()
            .status,
        TurnStatus::Queued
    );
    // Authenticate → the held turn re-runs first, then the queued one.
    wait(env.handle.authenticate(&task, "login")).unwrap();
    assert!(matches!(
        wait(queued.completed),
        TurnOutcome::Completed { .. }
    ));
    let turn = env
        .handle
        .turns(&task)
        .into_iter()
        .find(|t| t.turn_id == held.turn_id)
        .unwrap();
    assert_eq!(turn.status, TurnStatus::Completed);
    let row = env.handle.task(&task).unwrap();
    assert!(!row.auth_required);
    assert!(env.handle.is_signed_in("fake"));
    let users = texts(&env, &task)
        .into_iter()
        .filter(|(k, _)| *k == EntryType::User)
        .count();
    assert_eq!(users, 2, "the retry reuses the held turn's rows");
}

#[test]
fn permissions_auto_grant_allow_else_ask_the_app() {
    let env = env();
    let task = started(&env);
    prompt(&env, &task, "perm-allow", PromptExtras::default());
    assert!(texts(&env, &task).iter().any(|(_, t)| t == "perm:always"));
    assert!(env.handle.permission_requests(&task).is_empty());

    let h = wait(
        env.handle
            .prompt(&task, "perm-reject", PromptExtras::default()),
    );
    let request = (0..100)
        .find_map(|_| {
            std::thread::sleep(Duration::from_millis(20));
            env.handle.pending_permissions(&task).pop()
        })
        .expect("permission row");
    assert_eq!(request.title, "Run rm");
    assert_eq!(request.options[0].kind, "reject_once");
    wait(env.handle.respond_permission(
        &task,
        &request.id,
        PermissionOutcome::Selected("no".into()),
    ))
    .unwrap();
    wait(h.completed);
    assert!(texts(&env, &task).iter().any(|(_, t)| t == "perm:no"));
    assert_eq!(
        env.handle.permission_requests(&task)[0].status,
        PermissionStatus::Denied
    );
}

#[test]
fn cancel_settles_the_turn_and_the_queue() {
    let env = env();
    let task = started(&env);
    let running = wait(env.handle.prompt(&task, "slow", PromptExtras::default()));
    let queued = wait(
        env.handle
            .prompt(&task, "never echo", PromptExtras::default()),
    );
    std::thread::sleep(Duration::from_millis(100));
    wait(env.handle.cancel(&task)).unwrap();
    assert_eq!(wait(running.completed), TurnOutcome::Cancelled);
    assert_eq!(wait(queued.completed), TurnOutcome::Cancelled);
    assert_eq!(
        env.handle.task(&task).unwrap().status,
        TaskStatus::Cancelled
    );
    // The task still takes prompts after a cancel.
    assert!(matches!(
        prompt(&env, &task, "again echo", PromptExtras::default()),
        TurnOutcome::Completed { .. }
    ));
}

#[test]
fn escape_forgets_an_unanswered_turn() {
    let env = env();
    let task = started(&env);
    let running = wait(env.handle.prompt(&task, "slow", PromptExtras::default()));
    std::thread::sleep(Duration::from_millis(100));
    assert!(wait(env.handle.cancel_turn_and_forget(&task)));
    assert_eq!(wait(running.completed), TurnOutcome::Cancelled);
    assert!(env.handle.entries(&task).is_empty());
    assert!(env.handle.turns(&task).is_empty());
}

#[test]
fn fs_requests_go_through_services_with_containment() {
    let env = env();
    let task = started(&env);
    prompt(&env, &task, "write", PromptExtras::default());
    assert_eq!(
        std::fs::read_to_string(PathBuf::from(&env.ws).join("out.md")).unwrap(),
        "hello"
    );
    assert!(
        texts(&env, &task)
            .iter()
            .any(|(_, t)| t == "write:true escape:true read:hello")
    );
}

#[test]
fn config_switch_and_commands_ride_the_prompt() {
    let env = env();
    let task = started(&env);
    let extras = PromptExtras {
        config: vec![PromptConfigChange {
            category: "model".into(),
            value: "b".into(),
        }],
        commands: vec![PromptCommand {
            name: "review".into(),
        }],
        ..Default::default()
    };
    prompt(&env, &task, "echo this", extras);
    let row = env.handle.task(&task).unwrap();
    assert_eq!(row.current_model().as_deref(), Some("b"));
    let log = env.state.log.lock().unwrap();
    assert!(
        log.iter()
            .any(|m| m["method"] == "session/set_config_option" && m["params"]["value"] == "b")
    );
    let prompt_msg = log
        .iter()
        .rev()
        .find(|m| m["method"] == "session/prompt")
        .unwrap();
    assert_eq!(
        prompt_msg["params"]["prompt"][0]["text"],
        "/review echo this"
    );
    // Explicit switch through the handle.
    drop(log);
    wait(env.handle.set_config_option(&task, "model", "a")).unwrap();
    assert_eq!(
        env.handle.task(&task).unwrap().current_model().as_deref(),
        Some("a")
    );
    // The session/new carried the app's MCP server (session-new registration).
    let log = env.state.log.lock().unwrap();
    let new = log.iter().find(|m| m["method"] == "session/new").unwrap();
    assert_eq!(new["params"]["mcpServers"][0]["name"], "notefig");
    assert_eq!(
        new["params"]["mcpServers"][0]["env"][0]["name"],
        "NOTEFIG_MCP_TOKEN"
    );
}

#[test]
fn restart_restores_and_revives_with_replay() {
    let env = env();
    let task = started(&env);
    prompt(&env, &task, "go", PromptExtras::default());
    wait(env.handle.shutdown());
    let store = env.store.clone();
    // The persisted row carries no runtime-only fields.
    let persisted = store.0.lock().unwrap().tasks[&task].clone();
    assert!(persisted.get("configOptions").is_none());
    assert_eq!(persisted["usage"]["turns"], 1);

    let env2 = boot(store, tempfile::tempdir().unwrap(), Arc::default());
    let row = env2.handle.task(&task).unwrap();
    assert_eq!(row.status, TaskStatus::Restored);
    assert_eq!(row.title, "go");
    // Prompting revives through session/load; replay lands first.
    let outcome = prompt(&env2, &task, "new echo", PromptExtras::default());
    assert!(matches!(outcome, TurnOutcome::Completed { .. }));
    let t = texts(&env2, &task);
    assert_eq!(t[0], (EntryType::User, "old prompt".into()));
    assert_eq!(t[1], (EntryType::Assistant, "old answer".into()));
    assert_eq!(t[2].0, EntryType::ToolCall);
    assert_eq!(t[3], (EntryType::User, "new echo".into()));
    let replayed = &env2.handle.entries(&task)[2];
    assert_eq!(
        replayed.tool_call_view().unwrap().status.as_deref(),
        Some("completed")
    );
    assert!(
        replayed.created_at.is_none(),
        "replayed entries carry no timestamps"
    );
    let log = env2.state.log.lock().unwrap();
    assert!(
        log.iter()
            .any(|m| m["method"] == "session/load" && m["params"]["sessionId"] == "s1")
    );
    drop(log);
    // Closing the workspace demotes the row back to restored.
    wait(env2.handle.dispose_workspace(&env.ws));
    assert_eq!(
        env2.handle.task(&task).unwrap().status,
        TaskStatus::Restored
    );
}

#[test]
fn widget_prompt_is_framed_with_its_passage_and_context_link() {
    let env = env();
    let task = started(&env);
    let source = WidgetPromptSource {
        workspace_path: env.ws.clone(),
        path: "doc.md".into(),
        pos: 12,
        is_doc_empty: false,
        reference: Some((
            "quoted line".into(),
            notefig_agent::prompt::Range { from: 3, to: 9 },
        )),
    };
    let h =
        wait(
            env.handle
                .prompt_from_widget(&task, "echo fix it", source, PromptExtras::default()),
        );
    wait(h.completed);
    let log = env.state.log.lock().unwrap();
    let p = log
        .iter()
        .rev()
        .find(|m| m["method"] == "session/prompt")
        .unwrap();
    assert_eq!(
        p["params"]["prompt"][0]["text"],
        "> quoted line\n\necho fix it"
    );
    assert_eq!(
        p["params"]["prompt"][1]["uri"],
        "notefig://widget-context?path=doc.md&pos=12&from=3&to=9"
    );
}
