//! Process host (port of `src-tauri/src/agent_proc.rs`, minus Tauri and the
//! webview pull streams): login-shell PATH probe (cached, macOS), env scrub,
//! sidecar resolution, process-group spawn + kill, a registry so every
//! child can be killed on shutdown, and `run_shell_command` for install
//! probes / `opencode models`.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use smol::process::{ChildStderr, ChildStdin, ChildStdout, Command};

pub const LOGIN_SHELL_TIMEOUT: Duration = Duration::from_secs(10);
/// Env vars claude-agent-acp reads as "inside another Claude Code session".
const SCRUB_EXACT: &[&str] = &["CLAUDECODE"];
const SCRUB_PREFIX: &str = "CLAUDE_CODE_";
const SCRUB_KEEP: &[&str] = &["CLAUDE_CODE_EXECUTABLE"];
/// Fallback sidecar for this dev machine (see README).
pub const DEV_SIDECAR_FALLBACK: &str = "/Users/parsa/Documents/notefig/packages/desktop/src-tauri/binaries/claude-agent-acp-aarch64-apple-darwin";
pub const SIDECAR_PATH_ENV: &str = "NOTEFIG_SIDECAR_PATH";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProcErrorKind {
    SpawnFailed,
    ShellEnvUnavailable,
    Io,
}

#[derive(Debug, Clone)]
pub struct ProcError {
    pub kind: ProcErrorKind,
    pub message: String,
}

impl std::fmt::Display for ProcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

/// Race a future against a deadline.
pub async fn with_timeout<T>(
    duration: Duration,
    fut: impl std::future::Future<Output = T>,
) -> Option<T> {
    smol::future::or(async { Some(fut.await) }, async {
        smol::Timer::after(duration).await;
        None
    })
    .await
}

// ─── PATH ───────────────────────────────────────────────────────────────────

static LOGIN_PATH: Mutex<Option<String>> = Mutex::new(None);

fn login_path_from(stdout: &str) -> Option<String> {
    let start = stdout.find("__MP__")? + "__MP__".len();
    let rest = &stdout[start..];
    let end = rest.find("__END__")?;
    let path = &rest[..end];
    (!path.is_empty()).then(|| path.to_string())
}

fn login_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into())
}

#[cfg(windows)]
#[path = "process_windows.rs"]
mod win;

/// The PATH a child gets:
/// - macOS: the user's login-shell PATH (GUI apps get a bare one), probed
///   once and cached on success; a failure is re-probed next time.
/// - Windows: the live system + user PATH from the registry, read on every
///   spawn (the inherited one is a stale Explorer-startup snapshot).
/// - Linux/other: Ok(None) — the inherited PATH stands (a desktop session's
///   environment already carries the user's PATH).
pub async fn login_path() -> Result<Option<String>, String> {
    #[cfg(windows)]
    {
        return Ok(win::fresh_path());
    }
    #[allow(unreachable_code)]
    if !cfg!(target_os = "macos") {
        return Ok(None);
    }
    if let Some(path) = LOGIN_PATH.lock().unwrap().clone() {
        return Ok(Some(path));
    }
    let shell = login_shell();
    let mut cmd = Command::new(&shell);
    cmd.args(["-ilc", "printf '__MP__%s__END__' \"$PATH\""])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let output = with_timeout(LOGIN_SHELL_TIMEOUT, cmd.output())
        .await
        .ok_or_else(|| {
            format!(
                "`{shell} -ilc` took longer than {}s",
                LOGIN_SHELL_TIMEOUT.as_secs()
            )
        })?
        .map_err(|e| format!("couldn't run `{shell}`: {e}"))?;
    let path = login_path_from(&String::from_utf8_lossy(&output.stdout))
        .ok_or_else(|| format!("`{shell} -ilc` printed no PATH"))?;
    *LOGIN_PATH.lock().unwrap() = Some(path.clone());
    Ok(Some(path))
}

/// Seed the PATH cache (tests, or an app that already knows it).
pub fn set_login_path(path: Option<String>) {
    *LOGIN_PATH.lock().unwrap() = path;
}

#[derive(Debug, Clone)]
pub struct ShellOutput {
    pub stdout: String,
    pub exit_code: Option<i32>,
}

/// Run a script in the user's login shell (`$SHELL -ilc`), stdout only,
/// under the login-shell timeout.
pub async fn run_shell_command(script: &str) -> Result<ShellOutput, String> {
    // The probe scripts are POSIX and Windows has no login shell: "couldn't
    // check" (discovery records nothing, every harness stays visible).
    if cfg!(windows) {
        return Err("no login shell on Windows".into());
    }
    let shell = login_shell();
    let mut cmd = Command::new(&shell);
    cmd.args(["-ilc", script])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let output = with_timeout(LOGIN_SHELL_TIMEOUT, cmd.output())
        .await
        .ok_or_else(|| "shell command timed out".to_string())?
        .map_err(|e| format!("failed to run shell command: {e}"))?;
    Ok(ShellOutput {
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        exit_code: output.status.code(),
    })
}

// ─── Env ────────────────────────────────────────────────────────────────────

pub fn is_scrubbed_var(name: &str) -> bool {
    if SCRUB_KEEP.contains(&name) {
        return false;
    }
    SCRUB_EXACT.contains(&name) || name.starts_with(SCRUB_PREFIX)
}

/// The child env: inherited env minus the nested-session guards, PATH
/// replaced by the login PATH when known, then the harness's env + extras
/// on top (so a user's own `CLAUDE_CODE_*` setting survives).
pub fn child_env(
    login_path: Option<&str>,
    env: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    let mut out: BTreeMap<String, String> = std::env::vars()
        .filter(|(k, _)| !is_scrubbed_var(k))
        .collect();
    // Windows env names are case-insensitive (`Path` vs `PATH`): drop the
    // other spellings so the override isn't shadowed.
    let set = |out: &mut BTreeMap<String, String>, k: &str, v: &str| {
        if cfg!(windows) {
            out.retain(|existing, _| !existing.eq_ignore_ascii_case(k));
        }
        out.insert(k.to_string(), v.to_string());
    };
    if let Some(path) = login_path {
        set(&mut out, "PATH", path);
    }
    for (k, v) in env {
        set(&mut out, k, v);
    }
    out
}

// ─── Sidecars ───────────────────────────────────────────────────────────────

fn current_exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()?
        .parent()
        .map(Path::to_path_buf)
}

fn target_triple() -> &'static str {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "aarch64-apple-darwin"
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        "x86_64-apple-darwin"
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        "x86_64-unknown-linux-gnu"
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        "x86_64-pc-windows-msvc"
    } else {
        "unknown"
    }
}

/// `sidecar:<name>` → a file next to the current exe (plain or with the
/// target triple suffix), else `$NOTEFIG_SIDECAR_PATH`, else the dev
/// checkout's binary. Any other program is returned unchanged.
pub fn resolve_sidecar_program(program: &str) -> Result<String, String> {
    let Some(name) = program.strip_prefix(crate::harness::SIDECAR_SCHEME) else {
        return Ok(program.to_string());
    };
    if name.is_empty() || name.contains(['/', '\\']) {
        return Err(format!("invalid sidecar name in `{program}`"));
    }
    let ext = if cfg!(windows) { ".exe" } else { "" };
    if let Some(dir) = current_exe_dir() {
        for file in [
            format!("{name}{ext}"),
            format!("{name}-{}{ext}", target_triple()),
        ] {
            let path = dir.join(file);
            if path.is_file() {
                return Ok(path.to_string_lossy().into_owned());
            }
        }
    }
    if let Ok(path) = std::env::var(SIDECAR_PATH_ENV)
        && Path::new(&path).is_file()
    {
        return Ok(path);
    }
    if name == "claude-agent-acp" && Path::new(DEV_SIDECAR_FALLBACK).is_file() {
        return Ok(DEV_SIDECAR_FALLBACK.to_string());
    }
    Err(format!(
        "bundled adapter `{name}` not found next to the app, in ${SIDECAR_PATH_ENV}, or at the dev path"
    ))
}

// ─── Spawn / kill ───────────────────────────────────────────────────────────

static NEXT_PROC: AtomicU64 = AtomicU64::new(1);
static LIVE: Mutex<Option<HashMap<u64, Arc<Killer>>>> = Mutex::new(None);

/// How one child's tree is killed: its process group (Unix) or its Job
/// Object (Windows; `taskkill /T` when no job could be made).
struct Killer {
    pid: u32,
    #[cfg(windows)]
    job: Option<win::JobObject>,
}

impl Killer {
    fn new(pid: u32) -> Killer {
        Killer {
            pid,
            #[cfg(windows)]
            job: win::JobObject::for_pid(pid),
        }
    }
    fn kill(&self) {
        #[cfg(windows)]
        match &self.job {
            Some(job) => job.terminate(),
            None => win::taskkill_tree(self.pid),
        }
        #[cfg(not(windows))]
        kill_tree(self.pid);
    }
}

fn register(id: u64, killer: Arc<Killer>) {
    LIVE.lock()
        .unwrap()
        .get_or_insert_with(HashMap::new)
        .insert(id, killer);
}

fn unregister(id: u64) {
    if let Some(map) = LIVE.lock().unwrap().as_mut() {
        map.remove(&id);
    }
}

/// Kill a process group (the child was spawned as its own group leader).
pub fn kill_tree(pid: u32) {
    #[cfg(unix)]
    unsafe {
        libc::killpg(pid as i32, libc::SIGKILL);
    }
    #[cfg(not(unix))]
    let _ = pid;
}

/// Kill every agent process this host spawned (app exit).
pub fn kill_all() {
    let killers: Vec<Arc<Killer>> = LIVE
        .lock()
        .unwrap()
        .take()
        .map(|m| m.into_values().collect())
        .unwrap_or_default();
    for killer in killers {
        killer.kill();
    }
}

/// Number of live spawned processes (tests/diagnostics).
pub fn live_count() -> usize {
    LIVE.lock().unwrap().as_ref().map_or(0, HashMap::len)
}

#[derive(Debug, Clone, Default)]
pub struct SpawnSpec {
    /// The harness being run (a transport that is no process — the web
    /// tunnel's — names it to its worker instead of a program).
    pub harness_id: String,
    /// The task it serves; empty for a catalog probe.
    pub task_id: String,
    pub program: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    /// Harness env + adapter extras (applied over the scrubbed inherited env).
    pub env: BTreeMap<String, String>,
}

/// Kills the process group (and unregisters it) when dropped.
pub struct KillGuard {
    id: u64,
    pub pid: u32,
    killer: Arc<Killer>,
}

impl KillGuard {
    pub fn kill(&self) {
        self.killer.kill();
        unregister(self.id);
    }
}

impl Drop for KillGuard {
    fn drop(&mut self) {
        self.kill();
    }
}

/// A spawned agent process. Dropping `guard` kills the process group;
/// `exit` resolves with the exit code (dropping it also kills the child).
pub struct AgentProcess {
    pub guard: KillGuard,
    pub program: String,
    pub stdin: ChildStdin,
    pub stdout: ChildStdout,
    pub stderr: ChildStderr,
    pub exit: smol::Task<Option<i32>>,
}

/// Spawn an agent: login PATH (refusing to spawn if it can't be read and
/// the env doesn't carry one), sidecar resolution, scrubbed env, its own
/// process group, piped stdio.
pub async fn spawn_agent(spec: SpawnSpec) -> Result<AgentProcess, ProcError> {
    let path = match login_path().await {
        Ok(path) => path,
        Err(_) if spec.env.contains_key("PATH") => None,
        Err(reason) => {
            return Err(ProcError {
                kind: ProcErrorKind::ShellEnvUnavailable,
                message: format!(
                    "couldn't read your shell's PATH ({reason}), so `{}` wasn't started",
                    spec.program
                ),
            });
        }
    };
    let program = resolve_sidecar_program(&spec.program).map_err(|message| ProcError {
        kind: ProcErrorKind::SpawnFailed,
        message,
    })?;
    // A bare name → its concrete PATHEXT file (`.cmd` shims go through std's
    // strict-quoting cmd.exe path, CVE-2024-24576).
    #[cfg(windows)]
    let program = win::resolve_program(&program, &spec.env, path.as_deref());
    let mut std_cmd = std::process::Command::new(&program);
    std_cmd
        .args(&spec.args)
        .current_dir(&spec.cwd)
        .env_clear()
        .envs(child_env(path.as_deref(), &spec.env));
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        std_cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std_cmd.creation_flags(win::CREATE_NO_WINDOW);
    }
    let mut cmd: Command = std_cmd.into();
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| ProcError {
        kind: ProcErrorKind::SpawnFailed,
        message: format!("failed to spawn `{program}`: {e}"),
    })?;
    let id = NEXT_PROC.fetch_add(1, Ordering::Relaxed);
    let pid = child.id();
    let killer = Arc::new(Killer::new(pid));
    register(id, killer.clone());
    let io_error = |what: &str| ProcError {
        kind: ProcErrorKind::Io,
        message: format!("child {what} was not piped"),
    };
    let stdin = child.stdin.take().ok_or_else(|| io_error("stdin"))?;
    let stdout = child.stdout.take().ok_or_else(|| io_error("stdout"))?;
    let stderr = child.stderr.take().ok_or_else(|| io_error("stderr"))?;
    let exit = smol::spawn(async move {
        let status = child.status().await.ok();
        unregister(id);
        status.and_then(|s| s.code())
    });
    Ok(AgentProcess {
        guard: KillGuard { id, pid, killer },
        program,
        stdin,
        stdout,
        stderr,
        exit,
    })
}

// ─── Transport seam ─────────────────────────────────────────────────────────

/// An agent's byte streams. A spawned process is one; tests (and a future
/// web tunnel) supply others through [`TransportFactory`].
pub struct Transport {
    pub reader: Box<dyn smol::io::AsyncRead + Unpin>,
    pub writer: Box<dyn smol::io::AsyncWrite + Unpin>,
    pub stderr: Option<Box<dyn smol::io::AsyncRead + Unpin>>,
    /// Kills the process group when dropped (None for in-process agents).
    pub guard: Option<KillGuard>,
    /// Resolves with the exit code.
    pub exit: Option<smol::Task<Option<i32>>>,
}

impl From<AgentProcess> for Transport {
    fn from(p: AgentProcess) -> Self {
        Transport {
            reader: Box::new(p.stdout),
            writer: Box::new(p.stdin),
            stderr: Some(Box::new(p.stderr)),
            guard: Some(p.guard),
            exit: Some(p.exit),
        }
    }
}

/// Opens an agent's transport for a spawn spec. Called on the agent thread.
pub trait TransportFactory: Send + Sync + 'static {
    fn open(
        &self,
        spec: SpawnSpec,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Transport, ProcError>>>>;
}

/// The default: spawn the harness as a local child process.
pub struct ProcessTransport;

impl TransportFactory for ProcessTransport {
    fn open(
        &self,
        spec: SpawnSpec,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Transport, ProcError>>>> {
        Box::pin(async move { spawn_agent(spec).await.map(Transport::from) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scrubs_guards_but_keeps_executable() {
        assert!(is_scrubbed_var("CLAUDECODE"));
        assert!(is_scrubbed_var("CLAUDE_CODE_ENTRYPOINT"));
        assert!(is_scrubbed_var("CLAUDE_CODE_SESSION_ID"));
        assert!(!is_scrubbed_var("CLAUDE_CODE_EXECUTABLE"));
        assert!(!is_scrubbed_var("HOME"));
        let env: BTreeMap<String, String> =
            [("CLAUDE_CODE_USE_BEDROCK".to_string(), "1".to_string())].into();
        let out = child_env(Some("/x"), &env);
        assert_eq!(out["PATH"], "/x");
        assert_eq!(out["CLAUDE_CODE_USE_BEDROCK"], "1");
        assert!(!out.contains_key("CLAUDECODE"));
    }

    #[test]
    fn parses_login_path() {
        assert_eq!(
            login_path_from("noise__MP__/a:/b__END__").as_deref(),
            Some("/a:/b")
        );
        assert_eq!(login_path_from("__MP____END__"), None);
    }

    #[test]
    fn spawn_and_kill_group() {
        smol::block_on(async {
            let mut env = BTreeMap::new();
            env.insert("PATH".to_string(), "/bin:/usr/bin".to_string());
            let p = spawn_agent(SpawnSpec {
                program: "/bin/sh".into(),
                args: vec!["-c".into(), "sleep 30 & sleep 30".into()],
                cwd: "/".into(),
                env,
                ..Default::default()
            })
            .await
            .unwrap();
            assert!(live_count() >= 1);
            p.guard.kill();
            let code = with_timeout(Duration::from_secs(5), p.exit)
                .await
                .expect("exits after kill");
            assert!(code.is_none() || code != Some(0));
        });
    }
}
