/// Agent process host: spawn/stream/kill ACP adapter processes.
///
/// Custom commands rather than tauri-plugin-shell — the shell plugin's
/// sidecar model targets bundled binaries and its scoped `execute` doesn't
/// fit user-configured harness commands with a persistent stdin stream.
/// Contract with the frontend (tauri-stdio-transport.ts):
/// - commands below, errors-as-values like fs_ops
/// - line-buffered events: `agent-proc://{proc_id}/stdout-line`,
///   `agent-proc://{proc_id}/stderr-line`, `agent-proc://{proc_id}/exit`
/// - every spawned process is killed when the app shuts down
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "snake_case")]
pub enum AgentProcErrorType {
    SpawnFailed,
    NotFound,
    StdinClosed,
    IoError,
    Unknown,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AgentProcError {
    pub proc_id: String,
    #[serde(rename = "type")]
    pub error_type: AgentProcErrorType,
    pub message: String,
}

#[derive(Serialize, Deserialize)]
#[serde(untagged)]
pub enum AgentResult<T> {
    Ok { ok: bool, value: T },
    Err { ok: bool, error: AgentProcError },
}

impl<T> AgentResult<T> {
    pub fn ok(value: T) -> Self {
        AgentResult::Ok { ok: true, value }
    }

    pub fn err(proc_id: String, error_type: AgentProcErrorType, message: String) -> Self {
        AgentResult::Err {
            ok: false,
            error: AgentProcError {
                proc_id,
                error_type,
                message,
            },
        }
    }
}

/// Spawn an ACP adapter as a child process with piped stdio.
#[tauri::command]
pub async fn spawn_agent(
    proc_id: String,
    program: String,
    args: Vec<String>,
    cwd: String,
    env: HashMap<String, String>,
) -> AgentResult<()> {
    // TODO(phase 1): tokio::process::Command with piped stdio; register the
    // child in managed state keyed by proc_id; spawn tasks that read stdout/
    // stderr line-buffered and emit the namespaced events; emit exit on wait.
    let _ = (program, args, cwd, env);
    AgentResult::err(
        proc_id,
        AgentProcErrorType::SpawnFailed,
        "not implemented".to_string(),
    )
}

/// Write one JSON-RPC line (newline appended here) to the agent's stdin.
#[tauri::command]
pub async fn write_agent_stdin(proc_id: String, line: String) -> AgentResult<()> {
    // TODO(phase 1)
    let _ = line;
    AgentResult::err(
        proc_id,
        AgentProcErrorType::NotFound,
        "not implemented".to_string(),
    )
}

/// Kill the agent process. Idempotent: unknown proc_id is Ok.
#[tauri::command]
pub async fn kill_agent(proc_id: String) -> AgentResult<()> {
    // TODO(phase 1)
    let _ = proc_id;
    AgentResult::ok(())
}
