/// Agent process host: spawn/stream/kill ACP adapter processes.
///
/// Custom commands rather than tauri-plugin-shell — the shell plugin's
/// sidecar model targets bundled binaries and its scoped `execute` doesn't
/// fit user-configured harness commands with a persistent stdin stream.
/// Contract with the frontend (tauri-stdio-transport.ts):
/// - commands below, errors-as-values like fs_ops
/// - stdout/stderr are PULL streams (line_stream.rs, MET-98): the events
///   `agent-proc://{proc_id}/stdout-doorbell` and `…/stderr-doorbell` carry
///   no payload — they only signal "lines are waiting". The transport drains
///   `pull_stream_lines("agent-proc://{proc_id}/stdout")` (resp. `stderr`)
///   until an empty pull, and treats `ended: true` as end-of-stream. Line
///   payloads NEVER ride an emit — that path amplifies bytes ~6x and a
///   single oversized frame crashes the WebContent process.
/// - `agent-proc://{proc_id}/exit` fires on process exit; the transport
///   closes only after the stdout stream has ended, so exit can't overtake
///   undelivered lines.
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
/// the stdin sink for writes, a `Notify` the monitor selects on for kills,
/// and the pid so app-exit teardown can group-kill synchronously.
struct AgentHandle {
    stdin: AsyncMutex<ChildStdin>,
    kill: Notify,
    pid: Option<u32>,
}

/// Kill the child's entire process group. The spawn puts each adapter in its
/// own group (`process_group(0)`), so the group id is the child's pid. A
/// plain `start_kill` only reaches the direct child — for the built-in
/// harnesses that's an npx wrapper, and the real adapter + claude CLI
/// grandchildren reparent to launchd and keep running (verified 2026-07-23:
/// the orphaned adapter survives stdin EOF for minutes).
fn kill_process_group(pid: Option<u32>) {
    #[cfg(unix)]
    if let Some(pid) = pid {
        unsafe {
            libc::killpg(pid as i32, libc::SIGKILL);
        }
    }
    // Non-unix: the monitor's `start_kill` / `kill_on_drop` fallback applies.
    #[cfg(not(unix))]
    let _ = pid;
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
/// inside another Claude Code session"). Inherited whenever Notefig itself is
/// launched from a Claude Code terminal (dev/CI/e2e).
const NESTED_SESSION_GUARD_VARS: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_CHILD_SESSION",
];

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
    // Own process group so kills reach the whole tree (npx wrapper → adapter
    // shim → claude CLI), not just the wrapper. See kill_process_group.
    #[cfg(unix)]
    cmd.process_group(0);

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
        pid,
    });

    // Replace any stale entry with the same id (kill the old one first).
    if let Some(previous) = AGENT_PROCS
        .lock()
        .unwrap()
        .insert(proc_id.clone(), handle.clone())
    {
        previous.kill.notify_one();
    }

    // stdout/stderr readers fill pull streams; only payload-free doorbells
    // are emitted. See line_stream.rs for the design (MET-98).
    if let Some(stdout) = stdout {
        let app = app_handle.clone();
        let stream_id = format!("agent-proc://{}/stdout", proc_id);
        let doorbell_topic = format!("agent-proc://{}/stdout-doorbell", proc_id);
        let stream = crate::line_stream::create(&stream_id);
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            crate::line_stream::pump(&stream, &mut lines, || {
                let _ = app.emit(&doorbell_topic, ());
            })
            .await;
        });
    }

    if let Some(stderr) = stderr {
        let app = app_handle.clone();
        let stream_id = format!("agent-proc://{}/stderr", proc_id);
        let doorbell_topic = format!("agent-proc://{}/stderr-doorbell", proc_id);
        let stream = crate::line_stream::create(&stream_id);
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            crate::line_stream::pump(&stream, &mut lines, || {
                let _ = app.emit(&doorbell_topic, ());
            })
            .await;
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
                    kill_process_group(handle.pid);
                    let _ = child.start_kill();
                    child.wait().await.ok()
                }
                status = child.wait() => status.ok(),
            };
            // Deregister and report only while this monitor's process still
            // owns the id. A respawn under the same proc_id (session revival
            // after a webview reload, with the old adapter still alive)
            // replaces the registry entry and kills this child — removing
            // the entry or emitting exit here would then unregister the NEW
            // process's stdin and tear down its just-attached transport
            // (the exit topic is keyed by proc_id alone). A kill_agent call
            // already removed the entry itself, and its caller closes the
            // transport locally without waiting for an exit event.
            {
                let mut procs = AGENT_PROCS.lock().unwrap();
                match procs.get(&id) {
                    Some(current) if Arc::ptr_eq(current, &handle) => {
                        procs.remove(&id);
                    }
                    _ => return,
                }
            }
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
    // A kill comes from the transport's own close() — it will never pull
    // again, so drop the streams rather than leaving ended queues behind.
    crate::line_stream::remove_prefix(&format!("agent-proc://{}/", proc_id));
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
        // Group-kill directly (sync): at app exit the runtime may tear the
        // monitor down before it reacts to the notify, and kill_on_drop only
        // reaches the direct child, orphaning the adapter tree.
        kill_process_group(handle.pid);
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

    /// The orphan bug this module guards against: the spawned command is a
    /// wrapper (npx) whose *grandchild* is the real adapter/CLI. Killing only
    /// the direct child reparents the grandchild to launchd and leaks it.
    #[cfg(unix)]
    #[tokio::test]
    async fn kill_process_group_reaps_grandchildren() {
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", "sleep 300 & echo $!; wait"])
            .stdout(Stdio::piped())
            .kill_on_drop(true);
        cmd.process_group(0);
        let mut child = cmd.spawn().unwrap();
        let stdout = child.stdout.take().unwrap();
        let mut lines = BufReader::new(stdout).lines();
        let grandchild: i32 = lines
            .next_line()
            .await
            .unwrap()
            .expect("shell prints the grandchild pid")
            .trim()
            .parse()
            .unwrap();

        kill_process_group(child.id());
        let _ = child.wait().await;
        tokio::time::sleep(Duration::from_millis(200)).await;

        // kill(pid, 0) probes liveness without signaling. ESRCH means the
        // grandchild died with the group; 0 would mean it leaked.
        let alive = unsafe { libc::kill(grandchild, 0) } == 0;
        assert!(!alive, "grandchild {} survived the group kill", grandchild);
    }

    #[test]
    fn nested_session_guard_vars_include_claudecode() {
        // The auth spike found claude-code-acp refuses to start with these set.
        assert!(NESTED_SESSION_GUARD_VARS.contains(&"CLAUDECODE"));
    }

    /// End-to-end guard for the pull design (MET-98): spawn a real child
    /// through the production command whose stdout includes a line far above
    /// the high-water mark, and assert two invariants at the event bus:
    ///   1. doorbell events carry NO payload — a spawn path that regressed
    ///      to emitting line data would re-ship the WebContent crash;
    ///   2. every line (including the oversized one, whole and in order)
    ///      arrives via `pull_stream_lines`, with `ended` after EOF.
    #[cfg(unix)]
    #[test]
    fn stdout_reaches_the_webview_only_via_pull() {
        use tauri::Listener;

        let app = crate::test_support::mock_app();
        let webview = crate::test_support::main_webview(&app);

        let (tx, rx) = std::sync::mpsc::channel::<String>();
        app.listen("agent-proc://pull-e2e/stdout-doorbell", move |event| {
            let _ = tx.send(event.payload().to_string());
        });

        let oversized = crate::line_stream::HIGH_WATER_BYTES + 1024;
        let res = crate::test_support::invoke_json(
            &webview,
            "spawn_agent",
            serde_json::json!({
                "procId": "pull-e2e",
                "program": "/bin/sh",
                // A small frame, then one line above the high-water mark,
                // then exit (EOF marks the stream ended).
                "args": [
                    "-c",
                    format!("echo first; yes y | tr -d '\\n' | head -c {oversized}; echo"),
                ],
                "cwd": "/tmp",
                "env": {},
            }),
        )
        .expect("spawn_agent should return Ok");
        assert_eq!(res["ok"], serde_json::json!(true), "spawn failed: {res}");

        // Invariant 1: the doorbell is payload-free (tauri serializes the
        // unit payload as JSON null).
        let doorbell = rx
            .recv_timeout(Duration::from_secs(10))
            .expect("no doorbell arrived");
        assert!(
            doorbell.len() <= "null".len(),
            "doorbell carried a payload ({} bytes) — line data must never ride an emit",
            doorbell.len()
        );

        // Invariant 2: pulls deliver everything, in order, then report end.
        let mut lines: Vec<String> = Vec::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            let res = crate::test_support::invoke_json(
                &webview,
                "pull_stream_lines",
                serde_json::json!({ "streamId": "agent-proc://pull-e2e/stdout" }),
            )
            .expect("pull_stream_lines should return Ok");
            lines.extend(
                res["lines"]
                    .as_array()
                    .expect("lines array")
                    .iter()
                    .map(|l| l.as_str().expect("line is a string").to_string()),
            );
            if res["ended"] == serde_json::json!(true) {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "stream never ended; got {} lines so far",
                lines.len()
            );
            std::thread::sleep(Duration::from_millis(10));
        }

        assert_eq!(lines.len(), 2, "expected the small frame plus the big line");
        assert_eq!(lines[0], "first", "order lost");
        assert_eq!(lines[1].len(), oversized, "oversized line truncated or split");
    }
}
