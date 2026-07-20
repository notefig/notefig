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
///   (see `kill_all_agents`, wired to `RunEvent::Exit` in main.rs)
///
/// Two macOS/dev pitfalls, resolved here once for every harness (see the
/// Stage 0 spikes in docs/architecture/spikes/):
/// - GUI-launched apps get a bare PATH, so `npx`/`node` (nvm) don't resolve;
///   we replace the child PATH with a cached `$SHELL -ilc` probe (macOS only).
/// - claude-code-acp refuses to run "inside another Claude Code session", so
///   we strip the `CLAUDECODE` / `CLAUDE_CODE_*` guard vars from the child env.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};
use tokio::sync::{Mutex as AsyncMutex, Notify, OnceCell};

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

/// Emitted on `agent-proc://{proc_id}/exit`.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct ExitPayload {
    /// Process exit code when known (None if killed by signal).
    code: Option<i32>,
}

/// Returned from `spawn_agent` so the app can surface how the child was
/// launched (diagnostics D5). No env — it can carry secrets.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SpawnInfo {
    pub pid: Option<u32>,
    /// The PATH the child was given (login-shell probe on macOS, else inherited).
    pub resolved_path: Option<String>,
}

/// One live adapter process. The `tokio::process::Child` itself lives inside
/// the monitor task (so wait/kill never contend a shared lock); we keep only
/// the stdin sink for writes and a `Notify` the monitor selects on for kills.
struct AgentHandle {
    stdin: AsyncMutex<ChildStdin>,
    kill: Notify,
}

lazy_static::lazy_static! {
    /// proc_id → live handle. Sync mutex: critical sections never await, so
    /// `kill_all_agents` can drain it from the (sync) app-exit hook.
    static ref AGENT_PROCS: Mutex<HashMap<String, Arc<AgentHandle>>> =
        Mutex::new(HashMap::new());
}

// ========== PATH resolution (macOS GUI-launch pitfall) ==========

static LOGIN_PATH: OnceCell<Option<String>> = OnceCell::const_new();

/// The user's real login+interactive shell PATH, resolved once and cached.
/// macOS GUI apps inherit a bare PATH; without this, nvm-installed `npx`/`node`
/// are unresolvable. On other platforms we keep the inherited PATH (None).
async fn resolve_login_path() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        LOGIN_PATH.get_or_init(probe_login_path).await.clone()
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

#[cfg(target_os = "macos")]
async fn probe_login_path() -> Option<String> {
    // `-ilc` (login AND interactive): nvm loads from .zshrc (interactive) and
    // needs brew from .zprofile (login) — both flags are required. See
    // docs/architecture/spikes/phase1-macos-path-spike.md.
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let output = tokio::time::timeout(
        Duration::from_secs(5),
        Command::new(&shell)
            .args(["-ilc", "printf '__MP__%s__END__' \"$PATH\""])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output(),
    )
    .await
    .ok()? // timed out
    .ok()?; // spawn/io error

    let text = String::from_utf8_lossy(&output.stdout);
    // Init scripts may print banners; extract the PATH via the sentinel.
    let start = text.find("__MP__")? + "__MP__".len();
    let rest = &text[start..];
    let end = rest.find("__END__")?;
    let path = rest[..end].to_string();
    if path.is_empty() {
        None
    } else {
        Some(path)
    }
}

/// Guard vars that make claude-code-acp refuse to start ("cannot be launched
/// inside another Claude Code session"). Inherited whenever Metrists itself is
/// launched from a Claude Code terminal (dev/CI/e2e).
const NESTED_SESSION_GUARD_VARS: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_CHILD_SESSION",
];

// ========== Tauri commands ==========

/// Result of `run_shell_command`.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ShellCommandOutput {
    pub stdout: String,
    pub exit_code: Option<i32>,
}

/// Run an arbitrary script through the user's login+interactive shell and
/// capture its output. A generic execution primitive — this module has no
/// notion of what the script does or why (harness discovery is the first
/// caller, from the frontend; more may follow). Same `$SHELL -ilc` shape as
/// `probe_login_path` above, generalized to a caller-supplied script; no
/// PATH injection needed — `-ilc` sources the login/interactive init files,
/// which is where the probed PATH comes from in the first place.
#[tauri::command]
pub async fn run_shell_command(script: String) -> AgentResult<ShellCommandOutput> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let mut cmd = Command::new(&shell);
    cmd.args(["-ilc", &script])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        // A timeout drops the output() future — without this, a hung shell
        // would outlive the command and leak.
        .kill_on_drop(true);

    let output = match tokio::time::timeout(Duration::from_secs(10), cmd.output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(e)) => {
            return AgentResult::err(
                String::new(),
                AgentProcErrorType::SpawnFailed,
                format!("failed to run shell command: {}", e),
            );
        }
        Err(_) => {
            return AgentResult::err(
                String::new(),
                AgentProcErrorType::Unknown,
                "shell command timed out".to_string(),
            );
        }
    };

    AgentResult::ok(ShellCommandOutput {
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        exit_code: output.status.code(),
    })
}

/// Spawn an ACP adapter as a child process with piped stdio.
///
/// Runtime-generic so it registers on both `Wry` and the test `MockRuntime`
/// through the shared `register_handlers` (MET-73); the captured `AppHandle<R>`
/// still emits the stdout/stderr/exit events below.
#[tauri::command]
pub async fn spawn_agent<R: tauri::Runtime>(
    proc_id: String,
    program: String,
    args: Vec<String>,
    cwd: String,
    env: HashMap<String, String>,
    app_handle: AppHandle<R>,
) -> AgentResult<SpawnInfo> {
    let mut cmd = Command::new(&program);
    cmd.args(&args)
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Ensure the OS process dies with its Child (covers runtime teardown
        // at app exit even if the monitor task doesn't get scheduled).
        .kill_on_drop(true);

    // Replace PATH with the login-shell probe (macOS) so npx/node resolve.
    let resolved_path = resolve_login_path().await;
    if let Some(path) = &resolved_path {
        cmd.env("PATH", path);
    }
    // Harness-provided env overrides.
    for (key, value) in &env {
        cmd.env(key, value);
    }
    // Strip nested-session guards last (defensive against provided env too).
    for var in NESTED_SESSION_GUARD_VARS {
        cmd.env_remove(var);
    }

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            return AgentResult::err(
                proc_id,
                AgentProcErrorType::SpawnFailed,
                format!("failed to spawn `{}`: {}", program, e),
            );
        }
    };

    let pid = child.id();
    let stdin = match child.stdin.take() {
        Some(stdin) => stdin,
        None => {
            return AgentResult::err(
                proc_id,
                AgentProcErrorType::SpawnFailed,
                "child stdin was not piped".to_string(),
            );
        }
    };
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let handle = Arc::new(AgentHandle {
        stdin: AsyncMutex::new(stdin),
        kill: Notify::new(),
    });

    // Replace any stale entry with the same id (kill the old one first).
    if let Some(previous) = AGENT_PROCS
        .lock()
        .unwrap()
        .insert(proc_id.clone(), handle.clone())
    {
        previous.kill.notify_one();
    }

    // stdout reader: one event per line, newline stripped.
    if let Some(stdout) = stdout {
        let app = app_handle.clone();
        let topic = format!("agent-proc://{}/stdout-line", proc_id);
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = app.emit(&topic, line);
            }
        });
    }

    // stderr reader.
    if let Some(stderr) = stderr {
        let app = app_handle.clone();
        let topic = format!("agent-proc://{}/stderr-line", proc_id);
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = app.emit(&topic, line);
            }
        });
    }

    // Monitor: owns the Child; waits for natural exit or a kill signal, then
    // reaps, deregisters, and emits the exit event.
    {
        let app = app_handle.clone();
        let id = proc_id.clone();
        tauri::async_runtime::spawn(async move {
            let status = tokio::select! {
                _ = handle.kill.notified() => {
                    let _ = child.start_kill();
                    child.wait().await.ok()
                }
                status = child.wait() => status.ok(),
            };
            AGENT_PROCS.lock().unwrap().remove(&id);
            let code = status.and_then(|s| s.code());
            let _ = app.emit(&format!("agent-proc://{}/exit", id), ExitPayload { code });
        });
    }

    AgentResult::ok(SpawnInfo { pid, resolved_path })
}

/// Write one JSON-RPC line (newline appended here) to the agent's stdin.
#[tauri::command]
pub async fn write_agent_stdin(proc_id: String, line: String) -> AgentResult<()> {
    let handle = AGENT_PROCS.lock().unwrap().get(&proc_id).cloned();
    let handle = match handle {
        Some(handle) => handle,
        None => {
            return AgentResult::err(
                proc_id,
                AgentProcErrorType::NotFound,
                "no such agent process".to_string(),
            );
        }
    };

    let mut stdin = handle.stdin.lock().await;
    let mut bytes = line.into_bytes();
    bytes.push(b'\n');
    if let Err(e) = stdin.write_all(&bytes).await {
        return AgentResult::err(
            proc_id,
            AgentProcErrorType::StdinClosed,
            format!("write to stdin failed: {}", e),
        );
    }
    if let Err(e) = stdin.flush().await {
        return AgentResult::err(
            proc_id,
            AgentProcErrorType::IoError,
            format!("flush stdin failed: {}", e),
        );
    }
    AgentResult::ok(())
}

/// Kill the agent process. Idempotent: unknown proc_id is Ok.
#[tauri::command]
pub async fn kill_agent(proc_id: String) -> AgentResult<()> {
    let handle = AGENT_PROCS.lock().unwrap().remove(&proc_id);
    if let Some(handle) = handle {
        handle.kill.notify_one();
    }
    AgentResult::ok(())
}

/// Kill every live agent process. Called from the app-exit hook (main.rs).
/// Sync so it can run in the `RunEvent::Exit` closure; `kill_on_drop` is the
/// backstop if the runtime tears a monitor down before it reacts.
pub fn kill_all_agents() {
    let handles: Vec<Arc<AgentHandle>> = {
        let mut map = AGENT_PROCS.lock().unwrap();
        map.drain().map(|(_, handle)| handle).collect()
    };
    for handle in handles {
        handle.kill.notify_one();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ok_result_serializes_with_ok_true() {
        let json = serde_json::to_value(AgentResult::ok(())).unwrap();
        assert_eq!(json["ok"], true);
    }

    #[test]
    fn err_result_carries_typed_error_the_frontend_reads() {
        let result: AgentResult<()> = AgentResult::err(
            "task_1".to_string(),
            AgentProcErrorType::SpawnFailed,
            "boom".to_string(),
        );
        let json = serde_json::to_value(result).unwrap();
        assert_eq!(json["ok"], false);
        assert_eq!(json["error"]["type"], "spawn_failed");
        assert_eq!(json["error"]["proc_id"], "task_1");
        assert_eq!(json["error"]["message"], "boom");
    }

    #[tokio::test]
    async fn kill_unknown_proc_is_idempotent_ok() {
        let json = serde_json::to_value(kill_agent("does-not-exist".to_string()).await).unwrap();
        assert_eq!(json["ok"], true);
    }

    #[test]
    fn nested_session_guard_vars_include_claudecode() {
        // The auth spike found claude-code-acp refuses to start with these set.
        assert!(NESTED_SESSION_GUARD_VARS.contains(&"CLAUDECODE"));
    }
}
