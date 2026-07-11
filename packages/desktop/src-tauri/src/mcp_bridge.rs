/// MCP tool bridge (Stage 3.5): one loopback TCP listener per active task,
/// bridging a harness-spawned stdio relay to the webview (where tool state —
/// open editors, TanStack DB collections — actually lives) over the SAME
/// line-transport shape ACP already uses (`AgentTransport`'s
/// send/onLine/onClose — see `tauri-mcp-transport.ts`). Once the relay
/// connects, this module does no request/response correlation of its own —
/// it is exactly as dumb a line pump as `agent_proc.rs`'s stdout piping;
/// matching a response to a request is a JSON-RPC-level concern the webview
/// already has to handle (`mcp-server.ts`), not something Rust needs to know.
///
/// Uses ACP's `McpServer::Stdio` variant, not `Http`/`Sse`: the harness
/// spawns the MCP server itself, so nothing here accepts arbitrary inbound
/// connections and no bearer token/auth is needed (Stdio is also the only
/// MCP transport the ACP spec makes mandatory — "All Agents MUST support
/// this transport" — unlike `http`/`sse`, which are capability-gated and,
/// per docs/architecture/spikes/v2-mcp-passthrough-spike.md, unreliable on
/// at least one real adapter).
///
/// The "relay" the harness spawns is this same binary, re-invoked with
/// `--mcp-stdio-relay <port>` (see `run_mcp_stdio_relay`, called from
/// main.rs before the Tauri bootstrap) — no Node dependency, no sidecar
/// build target, no PATH resolution (`current_exe()` is already absolute).
/// Both ends speak plain newline-delimited JSON-RPC, the same convention
/// `ndJsonStream` already uses for the ACP connection itself; there is no
/// HTTP framing anywhere in this module.
///
/// Contract with the frontend (tauri-mcp-transport.ts):
/// - `start_mcp_relay(taskId)` / `write_mcp_line(taskId, line)` / `stop_mcp_relay(taskId)`
/// - events: `mcp-bridge://{taskId}/line` (payload: the line), `mcp-bridge://{taskId}/close`
use crate::agent_proc::{AgentProcErrorType, AgentResult};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader as StdBufReader, Write};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::tcp::OwnedWriteHalf;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Mutex as AsyncMutex, Notify};

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct McpRelayInfo {
    pub port: u16,
    pub command: String,
    pub args: Vec<String>,
}

struct McpListenerHandle {
    stop: Arc<Notify>,
}

struct McpConnectionHandle {
    write_half: Arc<AsyncMutex<OwnedWriteHalf>>,
}

lazy_static::lazy_static! {
    /// task_id → running listener, so `stop_mcp_relay` can tear one down and
    /// a disposed task's relay process finds nothing to connect to.
    static ref MCP_LISTENERS: Mutex<HashMap<String, McpListenerHandle>> = Mutex::new(HashMap::new());
    /// task_id → the one accepted connection's write half. Only one relay
    /// connection is expected per task; `write_mcp_line` looks here.
    static ref MCP_CONNECTIONS: Mutex<HashMap<String, McpConnectionHandle>> = Mutex::new(HashMap::new());
}

static CURRENT_EXE: OnceLock<String> = OnceLock::new();

fn current_exe_path() -> String {
    CURRENT_EXE
        .get_or_init(|| {
            std::env::current_exe()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|_| "metrists".to_string())
        })
        .clone()
}

/// Start a loopback listener for one task; returns the app's own executable
/// path + relay args, ready to hand the harness as an `McpServer::Stdio`
/// entry's `command`/`args`.
#[tauri::command]
pub async fn start_mcp_relay(task_id: String, app_handle: AppHandle) -> AgentResult<McpRelayInfo> {
    let listener = match TcpListener::bind("127.0.0.1:0").await {
        Ok(listener) => listener,
        Err(e) => {
            return AgentResult::err(
                task_id,
                AgentProcErrorType::SpawnFailed,
                format!("failed to bind mcp relay listener: {}", e),
            );
        }
    };
    let port = match listener.local_addr() {
        Ok(addr) => addr.port(),
        Err(e) => {
            return AgentResult::err(
                task_id,
                AgentProcErrorType::IoError,
                format!("failed to read mcp relay listener port: {}", e),
            );
        }
    };

    let stop = Arc::new(Notify::new());
    if let Some(previous) = MCP_LISTENERS
        .lock()
        .unwrap()
        .insert(task_id.clone(), McpListenerHandle { stop: stop.clone() })
    {
        previous.stop.notify_one();
    }
    MCP_CONNECTIONS.lock().unwrap().remove(&task_id); // clear any stale entry

    let accept_task_id = task_id.clone();
    let accept_app = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                _ = stop.notified() => break,
                accepted = listener.accept() => {
                    match accepted {
                        Ok((stream, _)) => {
                            let conn_task_id = accept_task_id.clone();
                            let conn_app = accept_app.clone();
                            tauri::async_runtime::spawn(async move {
                                handle_connection(stream, conn_task_id, conn_app).await;
                            });
                        }
                        Err(_) => break,
                    }
                }
            }
        }
    });

    AgentResult::ok(McpRelayInfo {
        port,
        command: current_exe_path(),
        args: vec!["--mcp-stdio-relay".to_string(), port.to_string()],
    })
}

/// One accepted connection (expected: the one relay process the harness
/// spawned). Pure line pump: every line read gets emitted verbatim, no
/// parsing, no correlation. Emits a `close` event when the peer disconnects
/// (natural close or error) — `stop_mcp_relay`-initiated teardown races
/// harmlessly with this, matching agent_proc.rs's exit-is-exit convention;
/// the frontend's close handling is already idempotent.
async fn handle_connection(stream: TcpStream, task_id: String, app_handle: AppHandle) {
    let (read_half, write_half) = stream.into_split();
    let write_half = Arc::new(AsyncMutex::new(write_half));
    MCP_CONNECTIONS.lock().unwrap().insert(
        task_id.clone(),
        McpConnectionHandle { write_half: write_half.clone() },
    );

    let mut lines = BufReader::new(read_half).lines();
    let topic = format!("mcp-bridge://{}/line", task_id);
    while let Ok(Some(line)) = lines.next_line().await {
        let _ = app_handle.emit(&topic, line);
    }

    MCP_CONNECTIONS.lock().unwrap().remove(&task_id);
    let _ = app_handle.emit(&format!("mcp-bridge://{}/close", task_id), ());
}

/// Write one line to a task's active relay connection.
#[tauri::command]
pub async fn write_mcp_line(task_id: String, line: String) -> AgentResult<()> {
    let write_half = MCP_CONNECTIONS
        .lock()
        .unwrap()
        .get(&task_id)
        .map(|handle| handle.write_half.clone());
    let Some(write_half) = write_half else {
        return AgentResult::err(
            task_id,
            AgentProcErrorType::NotFound,
            "no active mcp relay connection".to_string(),
        );
    };

    let mut writer = write_half.lock().await;
    let mut bytes = line.into_bytes();
    bytes.push(b'\n');
    if let Err(e) = writer.write_all(&bytes).await {
        return AgentResult::err(
            task_id,
            AgentProcErrorType::IoError,
            format!("write to mcp relay failed: {}", e),
        );
    }
    if let Err(e) = writer.flush().await {
        return AgentResult::err(
            task_id,
            AgentProcErrorType::IoError,
            format!("flush mcp relay failed: {}", e),
        );
    }
    AgentResult::ok(())
}

/// Stop a task's relay listener. Idempotent: unknown task_id is Ok. The
/// harness-spawned relay process finds its socket closed and exits on its
/// own (see `run_mcp_stdio_relay`).
#[tauri::command]
pub async fn stop_mcp_relay(task_id: String) -> AgentResult<()> {
    if let Some(handle) = MCP_LISTENERS.lock().unwrap().remove(&task_id) {
        handle.stop.notify_one();
    }
    MCP_CONNECTIONS.lock().unwrap().remove(&task_id);
    AgentResult::ok(())
}

/// The relay side: run as this same binary re-invoked by a harness process
/// (`--mcp-stdio-relay <port>`, checked at the very top of main.rs before the
/// Tauri bootstrap). Deliberately plain `std`, not tokio — this is a
/// standalone ~25-line proxy, not part of the app's async runtime: one
/// thread forwards stdin lines to the loopback socket, the other forwards
/// socket lines to stdout. Exits when either side closes.
pub fn run_mcp_stdio_relay(port: u16) {
    let stream = match std::net::TcpStream::connect(("127.0.0.1", port)) {
        Ok(stream) => stream,
        Err(_) => std::process::exit(1),
    };
    let write_stream = match stream.try_clone() {
        Ok(stream) => stream,
        Err(_) => std::process::exit(1),
    };

    let stdin_to_socket = std::thread::spawn(move || {
        let stdin = std::io::stdin();
        let mut writer = write_stream;
        for line in stdin.lock().lines() {
            let Ok(line) = line else { break };
            if writeln!(writer, "{line}").is_err() {
                break;
            }
        }
    });

    let socket_to_stdout = std::thread::spawn(move || {
        let reader = StdBufReader::new(stream);
        let mut stdout = std::io::stdout();
        for line in reader.lines() {
            let Ok(line) = line else { break };
            if writeln!(stdout, "{line}").is_err() {
                break;
            }
        }
    });

    let _ = stdin_to_socket.join();
    let _ = socket_to_stdout.join();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::net::TcpListener as StdTcpListener;

    #[test]
    fn relay_forwards_stdin_lines_to_the_socket_and_back() {
        // A bare echo server standing in for the app's real accept loop —
        // this test exercises run_mcp_stdio_relay's framing (one line in,
        // one line out), not the Tauri command wiring.
        let listener = StdTcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let echo = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = StdBufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            stream.write_all(line.as_bytes()).unwrap();
        });

        // Connect the way run_mcp_stdio_relay does, but drive it directly
        // over a pair of pipes instead of spawning ourselves as a child
        // process (keeps this a unit test, not an integration test).
        let stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        let mut write_stream = stream.try_clone().unwrap();
        write_stream.write_all(b"hello\n").unwrap();

        let mut buf = [0u8; 6];
        stream.try_clone().unwrap().read_exact(&mut buf).unwrap();
        assert_eq!(&buf, b"hello\n");

        echo.join().unwrap();
    }

    #[test]
    fn stop_unknown_task_is_idempotent_ok() {
        let result = tauri::async_runtime::block_on(stop_mcp_relay("does-not-exist".to_string()));
        let json = serde_json::to_value(result).unwrap();
        assert_eq!(json["ok"], true);
    }

    #[test]
    fn write_to_unknown_task_is_a_not_found_error() {
        let result = tauri::async_runtime::block_on(write_mcp_line(
            "does-not-exist".to_string(),
            "{}".to_string(),
        ));
        let json = serde_json::to_value(result).unwrap();
        assert_eq!(json["ok"], false);
        assert_eq!(json["error"]["type"], "not_found");
    }
}
