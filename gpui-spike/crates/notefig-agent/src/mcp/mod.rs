//! The app's MCP server (port of `packages/agent/src/mcp-server.ts`, a
//! hand-rolled stateless JSON-RPC handler) + its per-task loopback TCP
//! endpoint and the stdio relay (`src-tauri/src/mcp_bridge.rs`).
//!
//! Wiring: per task, [`McpEndpoint::start`] binds `127.0.0.1:0` with a
//! random token; the harness gets an ACP stdio MCP server whose command is
//! the relay (`notefig --mcp-stdio-relay <port>` in the app, or the
//! `notefig-mcp-relay <port>` bin) with env `NOTEFIG_MCP_TOKEN`. The relay
//! connects back, presents the token as its first line, then pumps lines.

pub mod relay;
pub mod tools;

use std::cell::RefCell;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use smol::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use smol::net::{TcpListener, TcpStream};
use smol::stream::StreamExt;

pub use relay::{MCP_TOKEN_ENV, RelayCommand, relay_main};
pub use tools::{
    ToolInput, WIDGET_RESPOND_TOOL_NAME, WidgetResponse, server_instructions, tool_registry,
};

use crate::paths::resolve_workspace_path;
use crate::prompt::decode_widget_context_uri;
use crate::rpc::{LocalBoxFuture, Spawner};
use crate::services::{AppToolCall, ClientRequest, ClientServices, reply_pair};

/// The app's MCP server name (`MCP_SERVER_NAME`).
pub const MCP_SERVER_NAME: &str = "notefig";

/// ACP `McpServer` stdio variant.
#[derive(Debug, Clone, PartialEq)]
pub struct StdioMcpServer {
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

impl StdioMcpServer {
    pub fn to_acp(&self) -> Value {
        json!({
            "name": self.name,
            "command": self.command,
            "args": self.args,
            "env": self.env.iter().map(|(n, v)| json!({"name": n, "value": v})).collect::<Vec<_>>(),
        })
    }
}


/// Spec revisions this handler is verified against, newest first.
pub const SUPPORTED_MCP_PROTOCOL_VERSIONS: &[&str] =
    &["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const TOKEN_TIMEOUT: Duration = Duration::from_secs(10);

pub fn negotiate_mcp_protocol_version(requested: Option<&str>) -> &'static str {
    requested
        .and_then(|r| SUPPORTED_MCP_PROTOCOL_VERSIONS.iter().find(|v| **v == r))
        .copied()
        .unwrap_or(SUPPORTED_MCP_PROTOCOL_VERSIONS[0])
}

/// What one task's MCP server reaches.
pub trait McpHost {
    fn task_id(&self) -> String;
    fn workspace_path(&self) -> PathBuf;
    fn services(&self) -> Arc<dyn ClientServices>;
    /// Ask the user (permission broker) — true = allowed.
    fn request_permission(&self, title: String) -> LocalBoxFuture<bool>;
    /// A request came in (diagnostics): its method, and the tool for tools/call.
    fn on_request(&self, _method: &str, _detail: &str) {}
}

fn result(id: &Value, result: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

fn error(id: &Value, code: i64, message: impl Into<String>) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message.into()}})
}

fn text_result(text: String, is_error: bool) -> Value {
    let mut v = json!({"content": [{"type": "text", "text": text}]});
    if is_error {
        v["isError"] = Value::Bool(true);
    }
    v
}

async fn ask_app<T>(
    services: &Arc<dyn ClientServices>,
    make: impl FnOnce(crate::services::Reply<Result<T, String>>) -> ClientRequest,
) -> Result<T, String> {
    let (reply, rx) = reply_pair();
    services.handle(make(reply));
    rx.recv()
        .await
        .unwrap_or_else(|_| Err("the app dropped the request".into()))
}

async fn dispatch(host: &Rc<dyn McpHost>, name: &str, input: ToolInput) -> Value {
    let spec = tool_registry().into_iter().find(|t| t.name == name);
    if let Some(spec) = &spec
        && spec.requires_permission
        && !host.request_permission(spec.title.to_string()).await
    {
        return text_result(format!("permission denied for \"{name}\""), true);
    }
    let workspace = host.workspace_path();
    let resolve = |path: &str| resolve_workspace_path(&workspace, path);
    let call = match input {
        ToolInput::WidgetRespond(_) => {
            return text_result(json!({"recorded": true}).to_string(), false);
        }
        ToolInput::ListDocuments => AppToolCall::ListDocuments,
        ToolInput::OpenFiles => AppToolCall::OpenFiles,
        ToolInput::HistoryCheckpoint { message } => AppToolCall::HistoryCheckpoint { message },
        ToolInput::ReadDocument { path, line, limit } => match resolve(&path) {
            Ok((path, relative)) => AppToolCall::ReadDocument {
                path,
                relative,
                line,
                limit,
            },
            Err(e) => return text_result(e, true),
        },
        ToolInput::DocumentReadRange { path, from, to } => match resolve(&path) {
            Ok((path, relative)) => AppToolCall::DocumentReadRange {
                path,
                relative,
                from,
                to,
            },
            Err(e) => return text_result(e, true),
        },
        ToolInput::HistoryLog { path } => match path.map(|p| resolve(&p)).transpose() {
            Ok(path) => AppToolCall::HistoryLog { path },
            Err(e) => return text_result(e, true),
        },
        ToolInput::HistoryDiff { path, from, to } => match resolve(&path) {
            Ok((path, relative)) => AppToolCall::HistoryDiff {
                path,
                relative,
                from,
                to,
            },
            Err(e) => return text_result(e, true),
        },
        ToolInput::HistoryRestore { path, checkpoint } => match resolve(&path) {
            Ok((path, relative)) => AppToolCall::HistoryRestore {
                path,
                relative,
                checkpoint,
            },
            Err(e) => return text_result(e, true),
        },
    };
    let services = host.services();
    let task_id = host.task_id();
    match ask_app::<Value>(&services, |reply| ClientRequest::Tool {
        task_id,
        workspace_path: workspace.clone(),
        call,
        reply,
    })
    .await
    {
        Ok(value) => text_result(value.to_string(), false),
        Err(e) => text_result(e, true),
    }
}

/// Handle one MCP JSON-RPC message; None for notifications.
pub async fn handle_mcp_message(host: Rc<dyn McpHost>, body: Value) -> Option<Value> {
    let id = body.get("id").cloned().unwrap_or(Value::Null);
    let method = body
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let params = body.get("params").cloned().unwrap_or(Value::Null);
    if !method.starts_with("notifications/") && method != "tools/call" {
        host.on_request(&method, "");
    }
    Some(match method.as_str() {
        "notifications/initialized" | "notifications/cancelled" => return None,
        m if m.starts_with("notifications/") => return None,
        "initialize" => {
            let requested = params.get("protocolVersion").and_then(Value::as_str);
            result(
                &id,
                json!({
                    "protocolVersion": negotiate_mcp_protocol_version(requested),
                    "capabilities": {"tools": {}, "resources": {}},
                    "serverInfo": {"name": MCP_SERVER_NAME, "version": "1.0.0"},
                    "instructions": server_instructions(),
                }),
            )
        }
        "ping" => result(&id, json!({})),
        "tools/list" => result(
            &id,
            json!({"tools": tool_registry().into_iter().map(|t| json!({
                "name": t.name,
                "title": t.title,
                "description": t.description,
                "inputSchema": t.input_schema,
            })).collect::<Vec<_>>()}),
        ),
        "resources/list" => result(&id, json!({"resources": []})),
        "resources/read" => {
            let uri = params
                .get("uri")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let Some(reference) = decode_widget_context_uri(&uri) else {
                return Some(error(
                    &id,
                    -32602,
                    format!(
                        "unknown resource uri: {}",
                        if uri.is_empty() { "(missing)" } else { &uri }
                    ),
                ));
            };
            let services = host.services();
            let task_id = host.task_id();
            let workspace_path = host.workspace_path();
            match ask_app::<Value>(&services, |reply| ClientRequest::WidgetContext {
                task_id,
                workspace_path,
                reference,
                reply,
            })
            .await
            {
                Ok(payload) => result(
                    &id,
                    json!({"contents": [{"uri": uri, "mimeType": "application/json", "text": serde_json::to_string_pretty(&payload).unwrap_or_default()}]}),
                ),
                Err(e) => error(&id, -32603, e),
            }
        }
        "tools/call" => {
            let name = params
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if !tool_registry().iter().any(|t| t.name == name) {
                return Some(error(
                    &id,
                    -32602,
                    format!(
                        "unknown tool: {}",
                        if name.is_empty() {
                            "(missing name)"
                        } else {
                            &name
                        }
                    ),
                ));
            }
            host.on_request("tools/call", &name);
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            let parsed = tools::validate(&name, &args).or_else(|first| {
                tools::parse_stringified_object_values(&args)
                    .map_or(Err(first), |fixed| tools::validate(&name, &fixed))
            });
            match parsed {
                Ok(input) => result(&id, dispatch(&host, &name, input).await),
                Err(problems) => result(
                    &id,
                    text_result(format!("invalid input for {name}: {problems}"), true),
                ),
            }
        }
        other => error(&id, -32601, format!("method not found: {other}")),
    })
}

/// One task's MCP endpoint: loopback listener + token. Dropping it stops
/// the listener and every relay connection.
pub struct McpEndpoint {
    pub port: u16,
    pub token: String,
    pub server: StdioMcpServer,
    tasks: Rc<RefCell<Vec<smol::Task<()>>>>,
}

impl McpEndpoint {
    pub async fn start(
        spawner: &Spawner,
        host: Rc<dyn McpHost>,
        relay: &RelayCommand,
    ) -> std::io::Result<McpEndpoint> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let port = listener.local_addr()?.port();
        let token = crate::ids::random_token();
        let tasks: Rc<RefCell<Vec<smol::Task<()>>>> = Rc::default();
        let accept_tasks = tasks.clone();
        let spawner2 = spawner.clone();
        let accept_token = token.clone();
        let accept = spawner.spawn(async move {
            let mut incoming = listener.incoming();
            while let Some(Ok(stream)) = incoming.next().await {
                let conn = spawner2.spawn(serve_connection(
                    spawner2.clone(),
                    stream,
                    accept_token.clone(),
                    host.clone(),
                ));
                accept_tasks.borrow_mut().push(conn);
            }
        });
        tasks.borrow_mut().push(accept);
        let mut args = relay.args.clone();
        args.push(port.to_string());
        Ok(McpEndpoint {
            port,
            token: token.clone(),
            server: StdioMcpServer {
                name: MCP_SERVER_NAME.into(),
                command: relay.program.to_string_lossy().into_owned(),
                args,
                env: vec![(MCP_TOKEN_ENV.into(), token)],
            },
            tasks,
        })
    }

    pub fn close(&self) {
        self.tasks.borrow_mut().clear();
    }
}

impl Drop for McpEndpoint {
    fn drop(&mut self) {
        self.close();
    }
}

async fn serve_connection(
    spawner: Spawner,
    stream: TcpStream,
    token: String,
    host: Rc<dyn McpHost>,
) {
    let mut lines = BufReader::new(stream.clone()).lines();
    let first = crate::process::with_timeout(TOKEN_TIMEOUT, lines.next()).await;
    match first {
        Some(Some(Ok(line))) if line.trim_end() == token => {}
        _ => return,
    }
    let (tx, rx) = async_channel::unbounded::<String>();
    let mut writer = stream;
    let write = spawner.spawn(async move {
        while let Ok(line) = rx.recv().await {
            let mut bytes = line.into_bytes();
            bytes.push(b'\n');
            if writer.write_all(&bytes).await.is_err() || writer.flush().await.is_err() {
                break;
            }
        }
    });
    let mut in_flight = vec![];
    while let Some(Ok(line)) = lines.next().await {
        if line.trim().is_empty() {
            continue;
        }
        let tx = tx.clone();
        let host = host.clone();
        in_flight.push(spawner.spawn(async move {
            let response = match serde_json::from_str::<Value>(&line) {
                Ok(body) => handle_mcp_message(host, body).await,
                Err(e) => Some(error(&Value::Null, -32700, e.to_string())),
            };
            if let Some(response) = response {
                let _ = tx.send(response.to_string()).await;
            }
        }));
        in_flight.retain(|t: &smol::Task<()>| !t.is_finished());
    }
    for task in in_flight {
        task.await;
    }
    drop(tx);
    write.await;
}
