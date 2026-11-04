//! The mock agent: a port of `modules/agents/mock-harness.ts` and
//! `mock-mode.ts`. A scripted ACP agent, the scenarios it plays, and the
//! env-gated harness (`NOTEFIG_AGENT_MOCK=1`, the TS `VITE_AGENT_MOCK=1`)
//! that serves it through the transport seam in place of a spawned adapter
//! process. The app runs its real ACP client, agent runtime, store and chat
//! UI; only the process on the far side of the transport is fake.
//!
//! Scenario choice, as TS: the configured one ([`configure_mock_agent`], or
//! `NOTEFIG_AGENT_MOCK_SCENARIO`), or a prompt starting with
//! `@@mock:{"scenario":"…","options":{…}}` (a one-turn override typed
//! straight into the composer).
//!
//! Scenarios: `echo` (TS default), `longTranscript` (TS), and — what the TS
//! e2e specs register per suite or replay from fixtures — `tools` (thought,
//! plan, a read, an edit written through `fs/write_text_file` with its
//! diff, a shell call, a reply), `permission` (a call the user must allow
//! or refuse), `widget` (answers an in-document prompt through the app's
//! MCP `widget_respond`), `choice` (asks a single-choice question there),
//! `slow` (streams slowly, for the queue and stop), `auth` (fails with
//! "Authentication required" until signed in) and `error`.
//!
//! Deviation: the scripted agent runs on its own std thread behind a
//! loopback socket (an in-process duplex the runtime thread can poll; a
//! socket is that, for free).

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use notefig_agent::process::{ProcError, SpawnSpec, Transport, TransportFactory};
use serde_json::{Value, json};

use crate::runtime::host::HostConfig;

/// `MOCK_AGENT_MODE`: `NOTEFIG_AGENT_MOCK=1`.
pub fn is_mock_mode() -> bool {
    std::env::var("NOTEFIG_AGENT_MOCK").is_ok_and(|v| v == "1")
}

/// Point the runtime at the mock: every harness is served by the scripted
/// agent, nothing is probed or discovered.
pub(crate) fn configure(config: &mut HostConfig) {
    config.transport = Arc::new(MockTransport);
    config.discover_on_boot = false;
    config.probe_catalogs = false;
}

/// `MockAgentConfig`.
#[derive(Debug, Clone, Default)]
pub struct MockAgentConfig {
    pub scenario: String,
    pub options: Value,
    /// Extra fields every `session/new` / `session/load` answers with
    /// (`configOptions`, `modes`, `models`). `None`: a model and an effort
    /// select (deviation: TS advertises none unless a spec seeds them; the
    /// screenshots want the config bar).
    pub session: Option<Value>,
    /// Commands every session reports right after `session/new`.
    pub commands: Option<Vec<Value>>,
}

const SCENARIOS: &[&str] = &[
    "echo", "longTranscript", "tools", "permission", "widget", "choice", "slow", "auth", "error",
];

fn active() -> &'static Mutex<MockAgentConfig> {
    static ACTIVE: OnceLock<Mutex<MockAgentConfig>> = OnceLock::new();
    ACTIVE.get_or_init(|| {
        Mutex::new(MockAgentConfig {
            scenario: std::env::var("NOTEFIG_AGENT_MOCK_SCENARIO").unwrap_or_else(|_| "echo".into()),
            ..Default::default()
        })
    })
}

/// `configureMockAgent`: the scenario future turns play (all mock tasks).
pub fn configure_mock_agent(config: MockAgentConfig) -> Result<(), String> {
    if !SCENARIOS.contains(&config.scenario.as_str()) {
        return Err(format!(
            "unknown mock scenario \"{}\" (have: {})",
            config.scenario,
            SCENARIOS.join(", ")
        ));
    }
    *active().lock().unwrap() = config;
    Ok(())
}

/// The scenarios' names.
pub fn scenarios() -> Vec<&'static str> {
    SCENARIOS.to_vec()
}

fn last_prompt() -> &'static Mutex<Value> {
    static LAST: OnceLock<Mutex<Value>> = OnceLock::new();
    LAST.get_or_init(|| Mutex::new(Value::Null))
}

/// `lastPrompt()`: the latest `session/prompt` params any mock agent got.
pub fn last_mock_prompt() -> Value {
    last_prompt().lock().unwrap().clone()
}

/// Per-session update history, process-wide so a revival (a fresh mock
/// agent, as a respawned adapter) can replay it on `session/load`.
fn histories() -> &'static Mutex<HashMap<String, Vec<Value>>> {
    static H: OnceLock<Mutex<HashMap<String, Vec<Value>>>> = OnceLock::new();
    H.get_or_init(Default::default)
}

fn record(session: &str, update: &Value) {
    histories()
        .lock()
        .unwrap()
        .entry(session.to_string())
        .or_default()
        .push(update.clone());
}

static SESSIONS: AtomicUsize = AtomicUsize::new(0);

/// `createMockAgentTransport`: the app side of a loopback pair whose far
/// side is a scenario-driven agent. One per task, as a spawned process.
pub struct MockTransport;

impl TransportFactory for MockTransport {
    fn open(
        &self,
        spec: SpawnSpec,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Transport, ProcError>>>> {
        Box::pin(async move {
            let err = |e: std::io::Error| ProcError {
                kind: notefig_agent::process::ProcErrorKind::SpawnFailed,
                message: e.to_string(),
            };
            let listener = TcpListener::bind("127.0.0.1:0").map_err(err)?;
            let addr = listener.local_addr().map_err(err)?;
            let cwd = spec.cwd.to_string_lossy().into_owned();
            std::thread::Builder::new()
                .name("notefig-mock-agent".into())
                .spawn(move || {
                    if let Ok((stream, _)) = listener.accept() {
                        MockAgent::run(stream, cwd);
                    }
                })
                .map_err(err)?;
            let stream = TcpStream::connect(addr).map_err(err)?;
            let reader = smol::Async::new(stream.try_clone().map_err(err)?).map_err(err)?;
            let writer = smol::Async::new(stream).map_err(err)?;
            Ok(Transport {
                reader: Box::new(reader),
                writer: Box::new(writer),
                stderr: None,
                guard: None,
                exit: None,
            })
        })
    }
}

/// The scripted agent: answers the real client over its socket.
struct MockAgent {
    writer: Mutex<TcpStream>,
    next_id: AtomicUsize,
    pending: Mutex<HashMap<u64, mpsc::Sender<Value>>>,
    abort: Mutex<Option<Arc<AtomicBool>>>,
    cwd: Mutex<String>,
    /// The app MCP server the session was handed: (port, token).
    mcp: Mutex<Option<(u16, String)>>,
    /// Current values of the session's select settings.
    config: Mutex<HashMap<String, String>>,
    signed_in: AtomicBool,
}

impl MockAgent {
    fn run(stream: TcpStream, cwd: String) {
        let Ok(write_half) = stream.try_clone() else { return };
        let agent = Arc::new(MockAgent {
            writer: Mutex::new(write_half),
            next_id: AtomicUsize::new(1),
            pending: Mutex::default(),
            abort: Mutex::default(),
            cwd: Mutex::new(cwd),
            mcp: Mutex::default(),
            config: Mutex::default(),
            signed_in: AtomicBool::new(false),
        });
        for line in BufReader::new(stream).lines() {
            let Ok(line) = line else { break };
            let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
            let method = msg.get("method").and_then(Value::as_str).map(str::to_string);
            match (method, msg.get("id").cloned()) {
                // The answer to one of our requests.
                (None, Some(id)) => {
                    let id = id.as_u64().unwrap_or(0);
                    if let Some(tx) = agent.pending.lock().unwrap().remove(&id) {
                        let _ = tx.send(msg.get("result").cloned().unwrap_or(Value::Null));
                    }
                }
                (Some(method), None) => {
                    if method == "session/cancel"
                        && let Some(flag) = agent.abort.lock().unwrap().as_ref()
                    {
                        flag.store(true, Ordering::SeqCst);
                    }
                }
                (Some(method), Some(id)) => {
                    let agent = agent.clone();
                    let params = msg.get("params").cloned().unwrap_or(Value::Null);
                    std::thread::spawn(move || match agent.handle(&method, &params) {
                        Ok(result) => agent.send(json!({"jsonrpc": "2.0", "id": id, "result": result})),
                        Err((code, message)) => agent.send(
                            json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}}),
                        ),
                    });
                }
                _ => {}
            }
        }
    }

    fn send(&self, msg: Value) {
        let mut w = self.writer.lock().unwrap();
        let _ = writeln!(w, "{msg}");
        let _ = w.flush();
    }

    /// A request to the client; waits for its answer.
    fn request(&self, method: &str, params: Value) -> Value {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst) as u64 + 10_000;
        let (tx, rx) = mpsc::channel();
        self.pending.lock().unwrap().insert(id, tx);
        self.send(json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}));
        rx.recv_timeout(Duration::from_secs(600)).unwrap_or(Value::Null)
    }

    fn update(&self, session: &str, update: Value) {
        record(session, &update);
        self.send_update(session, update);
    }

    fn send_update(&self, session: &str, update: Value) {
        self.send(json!({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": session, "update": update}}));
    }

    fn session_fields(&self) -> Value {
        if let Some(session) = active().lock().unwrap().session.clone() {
            return session;
        }
        let current = self.config.lock().unwrap();
        let model = current.get("model").cloned().unwrap_or_else(|| "opus".into());
        let effort = current.get("effort").cloned().unwrap_or_else(|| "high".into());
        json!({"configOptions": [
            {"id": "model", "name": "Model", "category": "model", "type": "select", "currentValue": model,
             "options": [{"value": "opus", "name": "Opus", "description": "Most capable"},
                         {"value": "sonnet", "name": "Sonnet", "description": "Fast and capable"}]},
            {"id": "effort", "name": "Effort", "category": "thought_level", "type": "select", "currentValue": effort,
             "options": [{"value": "low", "name": "Low"}, {"value": "medium", "name": "Medium"},
                         {"value": "high", "name": "High"}]}
        ]})
    }

    fn handle(self: &Arc<Self>, method: &str, params: &Value) -> Result<Value, (i64, String)> {
        match method {
            "initialize" => Ok(json!({
                "protocolVersion": 1,
                "agentCapabilities": {
                    "loadSession": true,
                    "promptCapabilities": {"embeddedContext": true},
                    "sessionCapabilities": {"delete": {}, "close": {}},
                },
                "authMethods": [{"id": "mock-login", "name": "Sign in", "description": "Run `mock login` in a terminal."}],
            })),
            "authenticate" => {
                self.signed_in.store(true, Ordering::SeqCst);
                Ok(json!({}))
            }
            "session/new" => {
                *self.cwd.lock().unwrap() = params["cwd"].as_str().unwrap_or_default().to_string();
                self.remember_mcp(params);
                let session = format!("mock_session_{}", SESSIONS.fetch_add(1, Ordering::SeqCst) + 1);
                let mut result = json!({"sessionId": session});
                if let (Some(obj), Some(extra)) = (result.as_object_mut(), self.session_fields().as_object()) {
                    obj.extend(extra.clone());
                }
                // Right after the response, as Claude does.
                let commands = active().lock().unwrap().commands.clone().unwrap_or_else(default_commands);
                let agent = self.clone();
                let sid = session.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(30));
                    agent.send_update(
                        &sid,
                        json!({"sessionUpdate": "available_commands_update", "availableCommands": commands}),
                    );
                });
                Ok(result)
            }
            "session/load" => {
                if let Some(cwd) = params["cwd"].as_str() {
                    *self.cwd.lock().unwrap() = cwd.to_string();
                }
                self.remember_mcp(params);
                let sid = params["sessionId"].as_str().unwrap_or_default().to_string();
                let history = histories().lock().unwrap().get(&sid).cloned().unwrap_or_default();
                for update in history {
                    self.send_update(&sid, update);
                }
                Ok(self.session_fields())
            }
            "session/set_config_option" => {
                let id = params["configId"].as_str().unwrap_or_default().to_string();
                let value = params["value"].as_str().unwrap_or_default().to_string();
                self.config.lock().unwrap().insert(id, value);
                Ok(json!({"configOptions": self.session_fields()["configOptions"].clone()}))
            }
            "session/set_mode" | "session/set_model" | "session/close" | "session/delete" => Ok(json!({})),
            "session/prompt" => self.prompt(params),
            other => Err((-32601, format!("Method not found: {other}"))),
        }
    }

    fn remember_mcp(&self, params: &Value) {
        let Some(server) = params["mcpServers"].as_array().and_then(|s| s.first()) else { return };
        let port = server["args"]
            .as_array()
            .and_then(|a| a.last())
            .and_then(Value::as_str)
            .and_then(|p| p.parse().ok());
        let token = server["env"].as_array().and_then(|env| {
            env.iter()
                .find(|e| e["name"] == "NOTEFIG_MCP_TOKEN")
                .and_then(|e| e["value"].as_str().map(str::to_string))
        });
        if let (Some(port), Some(token)) = (port, token) {
            *self.mcp.lock().unwrap() = Some((port, token));
        }
    }

    fn prompt(&self, params: &Value) -> Result<Value, (i64, String)> {
        *last_prompt().lock().unwrap() = params.clone();
        let session = params["sessionId"].as_str().unwrap_or_default().to_string();
        let text = prompt_text(params);
        let config = config_from_prompt(&text).unwrap_or_else(|| active().lock().unwrap().clone());
        record(&session, &json!({"sessionUpdate": "user_message_chunk", "content": {"type": "text", "text": text}}));
        // As claude-agent-acp replays a prompt's resource links: each its own
        // user chunk, the URI as text.
        for link in params["prompt"].as_array().into_iter().flatten().filter(|b| b["type"] == "resource_link") {
            if let Some(uri) = link["uri"].as_str() {
                record(&session, &json!({"sessionUpdate": "user_message_chunk", "content": {"type": "text", "text": uri}}));
            }
        }
        let abort = Arc::new(AtomicBool::new(false));
        *self.abort.lock().unwrap() = Some(abort.clone());
        let turn = Turn {
            agent: self,
            session,
            text,
            abort,
            options: config.options.clone(),
        };
        let result = turn.play(&config.scenario);
        if turn.aborted() {
            return Ok(json!({"stopReason": "cancelled"}));
        }
        result
    }
}

fn default_commands() -> Vec<Value> {
    vec![
        json!({"name": "review", "description": "Review the current changes"}),
        json!({"name": "summarize", "description": "Summarize a document"}),
    ]
}

/// `@@mock:{...}`: a one-turn config override.
fn config_from_prompt(text: &str) -> Option<MockAgentConfig> {
    let start = text.find("@@mock:")?;
    let rest = &text[start + "@@mock:".len()..];
    // The leading JSON value; a prompt may follow it (TS takes only a
    // prompt that is the directive alone).
    let parsed: Value = serde_json::Deserializer::from_str(rest.trim_start()).into_iter::<Value>().next()?.ok()?;
    let scenario = parsed["scenario"].as_str()?;
    SCENARIOS.contains(&scenario).then(|| MockAgentConfig {
        scenario: scenario.to_string(),
        options: parsed["options"].clone(),
        ..active().lock().unwrap().clone()
    })
}

fn prompt_text(params: &Value) -> String {
    params["prompt"]
        .as_array()
        .map(|blocks| {
            blocks
                .iter()
                .filter(|b| b["type"] == "text")
                .filter_map(|b| b["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

/// `MockTurnContext`: one prompt being played.
struct Turn<'a> {
    agent: &'a MockAgent,
    session: String,
    text: String,
    abort: Arc<AtomicBool>,
    options: Value,
}

/// Each mock session's running usage, as a harness keeps it.
fn meters() -> &'static Mutex<HashMap<String, (u64, f64)>> {
    static M: OnceLock<Mutex<HashMap<String, (u64, f64)>>> = OnceLock::new();
    M.get_or_init(Default::default)
}

type TurnResult = Result<Value, (i64, String)>;

impl Turn<'_> {
    fn aborted(&self) -> bool {
        self.abort.load(Ordering::SeqCst)
    }

    fn sleep(&self, ms: u64) {
        let mut left = ms;
        while left > 0 && !self.aborted() {
            let step = left.min(20);
            std::thread::sleep(Duration::from_millis(step));
            left -= step;
        }
    }

    fn emit(&self, update: Value) {
        self.agent.update(&self.session, update);
    }

    fn say(&self, kind: &str, text: &str, chunk: usize, ms: u64) {
        let chars: Vec<char> = text.chars().collect();
        for piece in chars.chunks(chunk.max(1)) {
            if self.aborted() {
                return;
            }
            let s: String = piece.iter().collect();
            self.emit(json!({"sessionUpdate": kind, "content": {"type": "text", "text": s}}));
            self.sleep(ms);
        }
    }

    fn cwd(&self) -> String {
        self.agent.cwd.lock().unwrap().clone()
    }

    fn play(&self, scenario: &str) -> TurnResult {
        match scenario {
            "longTranscript" => self.long_transcript(),
            "tools" => self.tools(),
            "permission" => self.permission(),
            "widget" => self.widget(false),
            "choice" => self.widget(true),
            "slow" => {
                let ms = self.options["ms"].as_u64().unwrap_or(150);
                self.say("agent_message_chunk", &format!("Working slowly on: {}\n\nStill going, one word at a time.", self.text), 5, ms);
                self.usage()
            }
            "auth" => {
                if self.agent.signed_in.load(Ordering::SeqCst) {
                    self.echo()
                } else {
                    Err((-32000, "Authentication required".into()))
                }
            }
            "error" => Err((-32603, "Internal error: the mock harness was told to fail".into())),
            _ => self.echo(),
        }
    }

    /// `echo()`: a short streamed echo, with usage the way harnesses report it.
    fn echo(&self) -> TurnResult {
        let shown = if self.text.is_empty() { "(nothing)" } else { &self.text };
        let reply = format!("You said:\n\n> {shown}\n\nMock harness reporting in.");
        self.say("agent_message_chunk", &reply, 24, 10);
        self.usage()
    }

    /// A `usage_update` with the context fill and the session's running
    /// cost (and Claude-shaped account limits), then per-turn tokens on the
    /// prompt response.
    fn usage(&self) -> TurnResult {
        let input = 40 + self.text.len() as u64;
        let output = 20;
        let (context, cost) = {
            let mut meters = meters().lock().unwrap();
            let meter = meters.entry(self.session.clone()).or_insert((12_000, 0.0));
            meter.0 += input + output;
            meter.1 += (input as f64 * 3.0 + output as f64 * 15.0) / 1_000_000.0 + 0.002;
            *meter
        };
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        self.emit(json!({
            "sessionUpdate": "usage_update",
            "used": context,
            "size": 200_000,
            "cost": {"amount": cost, "currency": "USD"},
            "_meta": {"_claude/rateLimit": {
                "status": "allowed",
                "isUsingOverage": false,
                "unifiedWindows": {
                    "five_hour": {"utilization": 0.42, "resetsAt": now + 7_200},
                    "seven_day": {"utilization": 0.18, "resetsAt": now + 259_200},
                }
            }}
        }));
        Ok(json!({
            "stopReason": "end_turn",
            "usage": {"inputTokens": input, "outputTokens": output,
                      "cachedReadTokens": context - input - output, "totalTokens": context}
        }))
    }

    /// `longTranscript`: many sections of markdown and thoughts.
    fn long_transcript(&self) -> TurnResult {
        let sections = self.options["sections"].as_u64().unwrap_or(12);
        for n in 1..=sections {
            if self.aborted() {
                break;
            }
            self.emit(json!({"sessionUpdate": "agent_thought_chunk", "content": {"type": "text",
                "text": format!("Thinking about section {n}: what to check, and in which order.")}}));
            self.emit(json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": format!(
                "## Section {n}\n\nA paragraph with **bold**, `code` and a [link](https://example.com).\n\n- first point\n- second point\n\n```ts\nconst section = {n};\n```\n\n"
            )}}));
            self.sleep(5);
        }
        self.usage()
    }

    /// A worked turn: thought, plan, read, edit (through the client's fs,
    /// so the app adopts it), a shell call, a reply.
    fn tools(&self) -> TurnResult {
        let cwd = self.cwd();
        let rel = self.options["path"].as_str().map(str::to_string).unwrap_or_else(|| pick_document(&cwd));
        let abs = Path::new(&cwd).join(&rel).to_string_lossy().into_owned();
        self.say(
            "agent_thought_chunk",
            &format!("The user wants a change in {rel}. I'll read it first, then add a short note at the end."),
            18,
            15,
        );
        let plan = |a: &str, b: &str, c: &str| {
            json!({"sessionUpdate": "plan", "entries": [
                {"content": format!("Read {rel}"), "priority": "high", "status": a},
                {"content": "Add the note", "priority": "high", "status": b},
                {"content": "Check the build", "priority": "medium", "status": c},
            ]})
        };
        self.emit(plan("in_progress", "pending", "pending"));
        self.sleep(80);
        self.emit(json!({"sessionUpdate": "tool_call", "toolCallId": "call_read", "title": format!("Read {rel}"),
            "kind": "read", "status": "pending", "locations": [{"path": abs}], "rawInput": {"file_path": abs}}));
        let old = self.agent.request("fs/read_text_file", json!({"sessionId": self.session, "path": abs}));
        let old = old["content"].as_str().unwrap_or_default().to_string();
        self.emit(json!({"sessionUpdate": "tool_call_update", "toolCallId": "call_read", "status": "completed"}));
        self.emit(plan("completed", "in_progress", "pending"));
        self.sleep(80);
        let note = self.options["note"].as_str().unwrap_or("Added by the mock agent.");
        let new = format!("{}\n\n{note}\n", old.trim_end_matches('\n'));
        self.emit(json!({"sessionUpdate": "tool_call", "toolCallId": "call_edit", "title": format!("Edit {rel}"),
            "kind": "edit", "status": "in_progress", "locations": [{"path": abs}],
            "rawInput": {"file_path": abs, "old_string": "", "new_string": note},
            "content": [{"type": "diff", "path": abs, "oldText": old, "newText": new}]}));
        let _ = self.agent.request("fs/write_text_file", json!({"sessionId": self.session, "path": abs, "content": new}));
        self.emit(json!({"sessionUpdate": "tool_call_update", "toolCallId": "call_edit", "status": "completed"}));
        self.emit(plan("completed", "completed", "in_progress"));
        self.emit(json!({"sessionUpdate": "tool_call", "toolCallId": "call_bash", "title": "npm run build",
            "kind": "execute", "status": "in_progress", "rawInput": {"command": "npm run build", "description": "Build the project"}}));
        self.sleep(150);
        self.emit(json!({"sessionUpdate": "tool_call_update", "toolCallId": "call_bash", "status": "completed",
            "content": [{"type": "content", "content": {"type": "text", "text": "built in 1.2s"}}]}));
        self.emit(plan("completed", "completed", "completed"));
        self.say(
            "agent_message_chunk",
            &format!("I added a note to the end of **{rel}**:\n\n> {note}\n\nThe build passes."),
            20,
            12,
        );
        self.usage()
    }

    /// A call that needs the user's answer: no allow option, so the
    /// runtime cannot auto-grant and shows the permission card.
    fn permission(&self) -> TurnResult {
        self.say("agent_message_chunk", "I need to clear the build folder first.", 16, 15);
        let call = json!({"toolCallId": "call_rm", "title": "Run rm -rf build/", "kind": "execute", "status": "pending",
            "rawInput": {"command": "rm -rf build/"}});
        let mut tool = call.clone();
        tool["sessionUpdate"] = json!("tool_call");
        self.emit(tool);
        let options = self.options["options"].as_array().cloned().unwrap_or_else(|| {
            vec![
                json!({"optionId": "reject", "name": "Not now", "kind": "reject_once"}),
                json!({"optionId": "never", "name": "Never", "kind": "reject_always"}),
            ]
        });
        let answer = self.agent.request(
            "session/request_permission",
            json!({"sessionId": self.session, "toolCall": call, "options": options}),
        );
        let picked = answer["outcome"]["optionId"].as_str().unwrap_or("cancelled").to_string();
        let allowed = picked.starts_with("allow");
        self.emit(json!({"sessionUpdate": "tool_call_update", "toolCallId": "call_rm",
            "status": if allowed { "completed" } else { "failed" }}));
        self.say(
            "agent_message_chunk",
            if allowed { "\n\nDone, the build folder is gone." } else { "\n\nOkay, I won't run it." },
            16,
            15,
        );
        self.usage()
    }

    /// An in-document prompt answered through the app's MCP server, as a
    /// real harness answers the widget (`widget_respond`).
    fn widget(&self, choice: bool) -> TurnResult {
        self.say("agent_thought_chunk", "Reading the widget's context.", 12, 15);
        let ask = self.text.lines().last().unwrap_or_default().trim().to_string();
        let args = if choice {
            json!({"kind": "single_choice", "title": "Which tone?", "markdown": "Which tone should the rewrite take?",
                   "options": ["Formal", "Friendly", "Terse"]})
        } else {
            let markdown = self.options["answer"].as_str().map(str::to_string).unwrap_or_else(|| {
                format!("Here is a short answer to **{ask}**: the mock harness read the document and found nothing to change.")
            });
            json!({"kind": "answer", "title": "Summary", "markdown": markdown})
        };
        // As Claude reports an MCP tool: a tool_call named
        // `mcp__<server>__<tool>` carrying its input, then its result.
        self.emit(json!({"sessionUpdate": "tool_call", "toolCallId": "call_widget", "title": "mcp__notefig__widget_respond",
            "kind": "other", "status": "in_progress", "rawInput": args.clone()}));
        match self.mcp_call("widget_respond", args) {
            Ok(result) => self.emit(json!({"sessionUpdate": "tool_call_update", "toolCallId": "call_widget",
                "status": "completed", "rawOutput": result})),
            Err(err) => {
                self.emit(json!({"sessionUpdate": "tool_call_update", "toolCallId": "call_widget", "status": "failed"}));
                self.say("agent_message_chunk", &format!("widget_respond failed: {err}"), 40, 0);
            }
        }
        self.usage()
    }

    fn mcp_call(&self, tool: &str, arguments: Value) -> Result<Value, String> {
        let (port, token) = self.agent.mcp.lock().unwrap().clone().ok_or("no MCP server was handed to this session")?;
        let stream = TcpStream::connect(("127.0.0.1", port)).map_err(|e| e.to_string())?;
        let mut writer = stream.try_clone().map_err(|e| e.to_string())?;
        let mut reader = BufReader::new(stream);
        // The relay protocol: the token is the first line.
        writeln!(writer, "{token}").map_err(|e| e.to_string())?;
        let mut call = |id: u64, method: &str, params: Value| -> Result<Value, String> {
            writeln!(writer, "{}", json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}))
                .map_err(|e| e.to_string())?;
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).map_err(|e| e.to_string())? == 0 {
                    return Err("MCP connection closed".into());
                }
                let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
                if msg["id"] == json!(id) {
                    if let Some(err) = msg.get("error") {
                        return Err(err.to_string());
                    }
                    return Ok(msg["result"].clone());
                }
            }
        };
        call(1, "initialize", json!({"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "mock", "version": "0"}}))?;
        let result = call(2, "tools/call", json!({"name": tool, "arguments": arguments}))?;
        if result["isError"] == json!(true) {
            return Err(result["content"][0]["text"].as_str().unwrap_or("tool error").to_string());
        }
        Ok(result)
    }
}

/// The document a `tools` turn edits: `README.md`, else the first
/// markdown file at the root, else `notes.md`.
fn pick_document(cwd: &str) -> String {
    if Path::new(cwd).join("README.md").is_file() {
        return "README.md".into();
    }
    std::fs::read_dir(cwd)
        .ok()
        .and_then(|dir| {
            let mut names: Vec<String> = dir
                .filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|n| n.ends_with(".md"))
                .collect();
            names.sort();
            names.into_iter().next()
        })
        .unwrap_or_else(|| "notes.md".into())
}
