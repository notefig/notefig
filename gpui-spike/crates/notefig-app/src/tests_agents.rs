//! Agent flows over a fake ACP agent (an in-process thread speaking ACP on
//! a loopback socket, plugged in through `TransportFactory`): chat send and
//! transcript, an agent write adopted into the open editor (undoable), a
//! permission card answer, and an in-document prompt widget round answered
//! through `widget_respond`.

use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::sync::Arc;
use std::time::Duration;

use gpui::{Entity, TestAppContext, VisualTestContext};
use notefig_agent::host::HostConfig;
use notefig_agent::process::{ProcError, SpawnSpec, Transport, TransportFactory};
use notefig_agent::store::PersistedState;
use notefig_agent::{ChannelServices, MemoryStore, StartResult};
use serde_json::{Value, json};

use crate::agents::Agents;
use crate::agents::chat::{ChatItem, ChatView};
use crate::agents::widget::{Outcome, PromptWidgetView, WidgetState};
use crate::document::DocKind;
use crate::layout::{OpenMode, Tab};
use crate::tests::{draw, fixture, init, md_source, open, open_file, workspace};

const AGENT_TEXT: &str = "# Alpha\n\nAgent wrote this.\n";

struct Fake {
    reader: BufReader<TcpStream>,
    writer: TcpStream,
    next_id: i64,
    session: String,
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
            if !line.trim().is_empty() {
                return serde_json::from_str(&line).ok();
            }
        }
    }
    fn update(&mut self, update: Value) {
        let sid = self.session.clone();
        self.send(json!({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": sid, "update": update}}));
    }
    fn chunk(&mut self, kind: &str, text: &str) {
        self.update(json!({"sessionUpdate": kind, "content": {"type": "text", "text": text}}));
    }
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

    fn run(mut self) {
        while let Some(msg) = self.read() {
            let Some(method) = msg.get("method").and_then(Value::as_str).map(str::to_string) else {
                continue;
            };
            let id = msg.get("id").cloned().unwrap_or(Value::Null);
            let params = msg.get("params").cloned().unwrap_or(Value::Null);
            match method.as_str() {
                "initialize" => self.respond(&id, json!({
                    "protocolVersion": 1,
                    "agentCapabilities": {"loadSession": true, "promptCapabilities": {"embeddedContext": true}},
                    "authMethods": [],
                })),
                "session/new" => {
                    self.session = "s1".into();
                    self.respond(&id, json!({"sessionId": "s1", "configOptions": [
                        {"id": "model", "name": "Model", "category": "model", "type": "select", "currentValue": "a",
                         "options": [{"value": "a", "name": "Model A"}, {"value": "b", "name": "Model B"}]}
                    ]}));
                }
                "session/set_config_option" | "session/close" | "session/delete" => self.respond(&id, json!({})),
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
        let text = params["prompt"]
            .as_array()
            .map(|blocks| blocks.iter().filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join("\n"))
            .unwrap_or_default();
        let sid = self.session.clone();
        if text.contains("please write") {
            let r = self.call("fs/write_text_file", json!({"sessionId": sid, "path": "a.md", "content": AGENT_TEXT}));
            let ok = r.get("result").is_some();
            self.chunk("agent_message_chunk", if ok { "Wrote a.md." } else { "write failed" });
        } else if text.contains("please ask") {
            let r = self.call("session/request_permission", json!({"sessionId": sid,
                "toolCall": {"toolCallId": "p1", "title": "Run rm"},
                "options": [{"optionId": "no", "name": "Reject", "kind": "reject_once"}, {"optionId": "later", "name": "Ask later", "kind": "other"}]}));
            let picked = r.pointer("/result/outcome/optionId").and_then(Value::as_str).unwrap_or("cancelled").to_string();
            self.chunk("agent_message_chunk", &format!("picked {picked}"));
        } else if text.contains("widget please") {
            self.update(json!({"sessionUpdate": "tool_call", "toolCallId": "w1", "title": "mcp__notefig__widget_respond",
                "kind": "other", "status": "completed",
                "rawInput": {"kind": "single_choice", "markdown": "Which **colour**?", "options": ["Red", "Blue"]}}));
        } else if text.contains("Blue") {
            self.update(json!({"sessionUpdate": "tool_call", "toolCallId": "w2", "title": "mcp__notefig__widget_respond",
                "kind": "other", "status": "completed",
                "rawInput": {"kind": "answer", "markdown": "Blue it is."}}));
        } else {
            self.chunk("agent_thought_chunk", "thinking");
            self.chunk("agent_message_chunk", "Hello ");
            self.chunk("agent_message_chunk", "**world**");
            self.update(json!({"sessionUpdate": "tool_call", "toolCallId": "t1", "title": "Edit a.md", "kind": "edit", "status": "completed",
                "content": [{"type": "diff", "path": "a.md", "oldText": "x\n", "newText": "y\n"}]}));
        }
        self.respond(&id, json!({"stopReason": "end_turn", "usage": {"inputTokens": 10, "outputTokens": 5}}));
    }
}

struct FakeTransport;

impl TransportFactory for FakeTransport {
    fn open(&self, _: SpawnSpec) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Transport, ProcError>>>> {
        Box::pin(async move {
            let listener = smol::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            std::thread::spawn(move || {
                let stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
                Fake {
                    reader: BufReader::new(stream.try_clone().unwrap()),
                    writer: stream,
                    next_id: 0,
                    session: String::new(),
                }
                .run();
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

/// Boot agents over the fake with one custom "fake" harness (the only
/// pickable one: built-ins are marked missing).
fn start_agents(cx: &mut TestAppContext) -> Entity<Agents> {
    let store = MemoryStore::default();
    {
        let mut p = PersistedState::default();
        p.harnesses.insert(
            "fake".into(),
            json!({"id": "fake", "createdAt": 1, "custom": {"id": "fake", "label": "Fake", "command": "fake-agent", "mcpRegistrationOverride": "session-new"}}),
        );
        for builtin in ["claude-code", "opencode", "gemini-cli", "devin", "codex"] {
            p.harnesses.insert(
                builtin.into(),
                json!({"id": builtin, "createdAt": 1, "discovery": {"harnessId": builtin, "found": false, "probedAt": 1}}),
            );
        }
        *store.0.lock().unwrap() = p;
    }
    let (services, requests) = ChannelServices::new();
    let mut config = HostConfig::new(store, services);
    config.discover_on_boot = false;
    config.probe_catalogs = false;
    config.startup_timeout = Duration::from_secs(5);
    config.transport = Arc::new(FakeTransport);
    cx.update(|cx| Agents::start(config, requests, cx))
}

/// Run the foreground until `done`, letting the agent thread work.
fn wait_until(cx: &mut VisualTestContext, what: &str, mut done: impl FnMut(&mut VisualTestContext) -> bool) {
    for _ in 0..400 {
        draw(cx);
        if done(cx) {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("timed out waiting for {what}");
}

fn start_chat(agents: &Entity<Agents>, ws_root: &str, ws: &Entity<crate::workspace_view::WorkspaceView>, cx: &mut VisualTestContext) -> Entity<ChatView> {
    let handle = agents.read_with(cx, |a, _| a.handle.clone());
    handle.trust(ws_root);
    let StartResult::Started { task_id } = handle.start_task(ws_root, "fake").recv_blocking().unwrap() else {
        panic!("not started")
    };
    cx.update(|window, cx| {
        ws.update(cx, |ws, cx| ws.open_tab(Tab::Chat { task_id: task_id.clone() }, OpenMode::Pinned, window, cx))
    });
    draw(cx);
    ws.read_with(cx, |ws, _| ws.chat(&task_id).expect("chat view"))
}

fn send(chat: &Entity<ChatView>, text: &str, cx: &mut VisualTestContext) {
    cx.update(|window, cx| {
        chat.update(cx, |c, cx| {
            c.composer.update(cx, |composer, cx| composer.set_text(text, cx));
            c.send(window, cx);
        })
    });
}

#[gpui::test]
fn chat_transcript_and_agent_write_adoption(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let f = fixture();
    init(cx, &f.state_path);
    let agents = start_agents(cx);
    let (root, cx) = open(cx, Some(f.ws_path.clone()));
    let ws = workspace(&root, cx);
    let ws_root = f.ws_path.to_string_lossy().into_owned();
    let doc = open_file(&ws, "a.md", cx);
    let chat = start_chat(&agents, &ws_root, &ws, cx);

    send(&chat, "hi there", cx);
    wait_until(cx, "the assistant reply", |cx| {
        chat.read_with(cx, |c, _| c.items.iter().any(|i| matches!(i, ChatItem::Assistant { text, .. } if text.contains("**world**"))))
    });
    let items = chat.read_with(cx, |c, _| c.items.clone());
    assert!(matches!(&items[0], ChatItem::User { text, .. } if text == "hi there"), "{items:?}");
    assert!(items.iter().any(|i| matches!(i, ChatItem::Thought { .. })));
    assert!(items.iter().any(|i| matches!(i, ChatItem::Tool { call, .. } if call.title.as_deref() == Some("Edit a.md"))));
    // Per-turn usage lands on the user bubble.
    wait_until(cx, "turn usage", |cx| {
        chat.read_with(cx, |c, _| c.items.iter().any(|i| matches!(i, ChatItem::User { usage: Some(_), .. })))
    });

    // fs/write_text_file adopts into the open editor as one undoable step.
    let original = md_source(&doc, cx);
    send(&chat, "please write", cx);
    wait_until(cx, "the adopted write", |cx| md_source(&doc, cx) == AGENT_TEXT);
    assert_eq!(std::fs::read_to_string(f.ws_path.join("a.md")).unwrap(), AGENT_TEXT);
    assert!(!doc.read_with(cx, |d, _| d.is_dirty()));
    let editor = doc.read_with(cx, |d, _| match &d.kind {
        DocKind::Markdown { editor, .. } => editor.clone(),
        _ => unreachable!(),
    });
    cx.update(|_, cx| editor.update(cx, |e, cx| e.undo(cx)));
    draw(cx);
    assert_eq!(md_source(&doc, cx), original);
}

#[gpui::test]
fn permission_card_answer_and_mcp_tools(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let f = fixture();
    init(cx, &f.state_path);
    let agents = start_agents(cx);
    let (root, cx) = open(cx, Some(f.ws_path.clone()));
    let ws = workspace(&root, cx);
    let ws_root = f.ws_path.to_string_lossy().into_owned();
    let chat = start_chat(&agents, &ws_root, &ws, cx);
    send(&chat, "please ask", cx);
    wait_until(cx, "the permission card", |cx| {
        chat.read_with(cx, |c, _| c.items.iter().any(|i| matches!(i, ChatItem::Permission(_))))
    });
    let req = chat.read_with(cx, |c, _| {
        c.items.iter().find_map(|i| match i {
            ChatItem::Permission(r) => Some(r.clone()),
            _ => None,
        })
    }).unwrap();
    assert_eq!(req.title, "Run rm");
    agents.read_with(cx, |a, _| a.handle.respond_permission(&req.task_id, &req.id, notefig_agent::PermissionOutcome::Selected("later".into())));
    wait_until(cx, "the answer", |cx| {
        chat.read_with(cx, |c, _| c.items.iter().any(|i| matches!(i, ChatItem::Assistant { text, .. } if text.contains("picked later"))))
    });

    // The app answers MCP tool calls from live state.
    let root_path = f.ws_path.clone();
    let value = cx
        .update(|_, cx| {
            agents.update(cx, |a, cx| {
                crate::agents::services::tool(a, &root_path, notefig_agent::AppToolCall::OpenFiles, cx)
            })
        })
        .unwrap();
    assert!(value["tabs"].as_array().is_some_and(|t| !t.is_empty()), "{value}");
    let docs = cx
        .update(|_, cx| {
            agents.update(cx, |a, cx| {
                crate::agents::services::tool(a, &root_path, notefig_agent::AppToolCall::ListDocuments, cx)
            })
        })
        .unwrap();
    assert!(docs.as_array().unwrap().iter().any(|d| d["path"] == "a.md"), "{docs}");
}

#[gpui::test]
fn prompt_widget_round_answers_via_widget_respond(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let f = fixture();
    init(cx, &f.state_path);
    let _agents = start_agents(cx);
    let (root, cx) = open(cx, Some(f.ws_path.clone()));
    let ws = workspace(&root, cx);
    let doc = open_file(&ws, "b.md", cx);
    let editor = doc.read_with(cx, |d, _| d.markdown_editor().cloned().unwrap());
    // `/` in an empty paragraph inserts a widget (the editor's slash event).
    cx.update(|window, cx| {
        editor.update(cx, |e, cx| {
            let _ = e.select_end(cx);
            e.focus(window, cx);
        })
    });
    cx.simulate_keystrokes("enter");
    cx.simulate_input("/");
    draw(cx);
    let view: Entity<PromptWidgetView> = doc.read_with(cx, |d, _| {
        d.widgets.as_ref().unwrap().views.borrow().values().next().cloned().expect("widget view rendered")
    });
    let send = |text: &str, cx: &mut VisualTestContext| {
        cx.update(|window, cx| {
            view.update(cx, |v, cx| {
                v.composer.update(cx, |c, cx| c.set_text(text, cx));
                v.send(window, cx);
            })
        });
    };
    // First send asks to trust the workspace; the second sends.
    send("widget please", cx);
    assert_eq!(view.read_with(cx, |v, _| v.state), WidgetState::Composing { confirming_trust: true });
    send("widget please", cx);
    wait_until(cx, "the question", |cx| {
        view.read_with(cx, |v, _| v.state) == WidgetState::Asking(crate::agents::widget::Ask::Question)
    });
    // The widget is bound: its marker is in the document.
    assert!(md_source(&doc, cx).contains("<!-- notefig:prompt"), "{}", md_source(&doc, cx));
    // Answering the single choice sends a reply; the round settles done.
    send("Blue", cx);
    wait_until(cx, "the answer", |cx| view.read_with(cx, |v, _| v.state) == WidgetState::Settled(Outcome::Done));
}
