//! Credentials for git remotes, used only by
//! `git_http.rs`: a token never reaches JS, the git worker or an agent.
//!
//! A remote's credential comes from, in order:
//! 1. a token pasted into Notefig, kept in the OS keychain per remote
//!    (`host/owner/repo`, see `git_http::remote_key`);
//! 2. git's own credential helper (`git credential fill`), when git is
//!    installed — whatever the user set up for git (osxkeychain, GCM,
//!    libsecret, a store file) works as it does for git;
//! 3. the GitHub CLI (`gh auth token`).
//!
//! What is found is held in memory for the session, never copied. A 401
//! drops it (see `retry_after`), and a refused git or gh credential is
//! skipped for the rest of the session (never rejected back to the user's
//! helper: it may be fine for their other repositories). The frontend learns the source and
//! username, never the secret.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::git_http::{remote_key, validate_url};

const SERVICE: &str = "com.notefig.app.git-remote";
/// A helper that opens a dialog (GCM) is cut off after this.
const HELPER_TIMEOUT: Duration = Duration::from_secs(20);
/// Where `git`/`gh` usually live when a GUI launch's PATH misses them.
const EXTRA_BIN_DIRS: [&str; 2] = ["/opt/homebrew/bin", "/usr/local/bin"];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Source {
    Stored,
    Git,
    GithubCli,
}

#[derive(Clone)]
pub struct Credential {
    pub username: String,
    pub token: String,
    source: Source,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct Context {
    remote: String,
    repo: String,
}

fn context(remote: &str, repo: Option<&str>) -> Context {
    Context { remote: remote.to_string(), repo: repo.unwrap_or_default().to_string() }
}

#[derive(Serialize)]
pub struct Status {
    source: Source,
    username: String,
}

#[derive(Default)]
struct Session {
    /// Helper results are repository-local: conditional git config may pick
    /// a different helper/account for two clones of the same remote.
    found: HashMap<Context, Credential>,
    /// Remotes nothing was found for: requests go without a credential
    /// instead of running the helpers each time; an explicit status asks again.
    missing: HashSet<Context>,
    refused: HashSet<(Context, Source)>,
}

static SESSION: Mutex<Option<Session>> = Mutex::new(None);
/// One resolution at a time: concurrent requests wait for the first.
static RESOLVING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn session<T>(run: impl FnOnce(&mut Session) -> T) -> T {
    run(SESSION.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(Session::default))
}

/// The username a host takes with a bare token.
fn token_username(key: &str) -> &'static str {
    if key.starts_with("gitlab.") { "oauth2" } else { "x-access-token" }
}

// ── 1. The keychain ─────────────────────────────────────────────────────

async fn keychain<T: Send + 'static>(
    run: impl FnOnce(keyring::Entry) -> keyring::Result<T> + Send + 'static,
    key: &str,
) -> Result<Option<T>, String> {
    let key = key.to_string();
    tauri::async_runtime::spawn_blocking(move || match run(keyring::Entry::new(SERVICE, &key)?) {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e),
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

// ── 2 and 3. The user's tools ───────────────────────────────────────────

pub(crate) fn find_tool(name: &str, path: Option<&str>) -> Option<PathBuf> {
    let exe = if cfg!(windows) { format!("{name}.exe") } else { name.to_string() };
    let dirs = path.map(|p| std::env::split_paths(p).collect::<Vec<_>>()).unwrap_or_default();
    let found = dirs
        .into_iter()
        .chain(EXTRA_BIN_DIRS.iter().map(PathBuf::from))
        .map(|dir| dir.join(&exe))
        .find(|candidate| candidate.is_file())?;
    // On a Mac without developer tools, /usr/bin/git is a stub that opens
    // the "install command line tools" dialog.
    let stub = cfg!(target_os = "macos")
        && found == Path::new("/usr/bin/git")
        && !Path::new("/Library/Developer/CommandLineTools/usr/bin/git").is_file()
        && !Path::new("/Applications/Xcode.app/Contents/Developer/usr/bin/git").is_file();
    (!stub).then_some(found)
}

/// Run a tool non-interactively; its stdout on success.
async fn run_tool(name: &str, args: &[&str], input: Option<String>, repo: Option<&str>) -> Option<String> {
    let path = crate::agent_proc::resolve_login_path().await.ok().flatten().or_else(|| std::env::var("PATH").ok());
    let program = find_tool(name, path.as_deref())?;
    let mut command = Command::new(program);
    command
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .env_remove("GIT_ASKPASS")
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    if let Some(path) = path {
        command.env("PATH", path);
    }
    // From inside the repository, so its own config and includes apply.
    if let Some(dir) = repo.filter(|dir| Path::new(dir).is_dir()) {
        command.current_dir(dir);
    }
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let mut child = command.spawn().ok()?;
    if let (Some(text), Some(mut stdin)) = (input, child.stdin.take()) {
        stdin.write_all(text.as_bytes()).await.ok()?;
    }
    let output = tokio::time::timeout(HELPER_TIMEOUT, child.wait_with_output()).await.ok()?.ok()?;
    output.status.success().then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

/// The `key=value` lines `git credential fill` prints.
fn parse_fill(output: &str) -> Option<(String, String)> {
    let field = |name: &str| {
        output.lines().find_map(|line| line.strip_prefix(name)?.strip_prefix('=')).filter(|v| !v.is_empty())
    };
    Some((field("username").unwrap_or("x-access-token").to_string(), field("password")?.to_string()))
}

async fn git_fill(key: &str, repo: Option<&str>) -> Option<Credential> {
    let (host, path) = key.split_once('/')?;
    let input = format!("protocol=https\nhost={host}\npath={path}.git\n\n");
    let (username, token) = parse_fill(&run_tool("git", &["credential", "fill"], Some(input), repo).await?)?;
    Some(Credential { username, token, source: Source::Git })
}

async fn github_cli(key: &str) -> Option<Credential> {
    let (host, _) = key.split_once('/')?;
    let token = run_tool("gh", &["auth", "token", "--hostname", host], None, None).await?.trim().to_string();
    (!token.is_empty()).then(|| Credential { username: "x-access-token".into(), token, source: Source::GithubCli })
}

// ── Resolution ──────────────────────────────────────────────────────────

async fn resolve(key: &str, ask_again: bool, repo: Option<&str>) -> Option<Credential> {
    let _one = RESOLVING.lock().await;
    let context = context(key, repo);
    let (found, missing) = session(|s| (s.found.get(&context).cloned(), s.missing.contains(&context)));
    if found.is_some() || (missing && !ask_again) {
        return found;
    }
    let stored = keychain(|entry| entry.get_password(), key).await.ok().flatten().map(|token| Credential {
        username: token_username(key).into(),
        token,
        source: Source::Stored,
    });
    let refused = |source| session(|s| s.refused.contains(&(context.clone(), source)));
    let found = match stored {
        Some(found) => Some(found),
        None if !refused(Source::Git) => match git_fill(key, repo).await {
            Some(found) => Some(found),
            None if !refused(Source::GithubCli) => github_cli(key).await,
            None => None,
        },
        None if !refused(Source::GithubCli) => github_cli(key).await,
        None => None,
    };
    session(|s| match &found {
        Some(found) => {
            s.missing.remove(&context);
            s.found.insert(context, found.clone());
        }
        None => {
            s.missing.insert(context);
        }
    });
    found
}

/// The credential for a request to the remote `key`.
pub(crate) async fn for_remote(key: &str, repo: Option<&str>) -> Option<Credential> {
    resolve(key, false, repo).await
}

/// Whether to send a request again after this answer. A 401 drops the
/// credential: a git or gh one gives way to the next source, while a token
/// the user pasted stands until they replace it, so the 401 reaches them and
/// nothing goes out under an account they didn't choose. Any other status
/// says nothing about the credential: a 403 can be a read-only token on a
/// push, or a rate limit.
pub(crate) fn retry_after(key: &str, repo: Option<&str>, used: Option<&Credential>, status: u16) -> bool {
    let Some(used) = used.filter(|_| status == 401) else {
        return false;
    };
    let context = context(key, repo);
    session(|s| {
        // The user may have switched credentials while this request ran.
        if s.found.get(&context).is_some_and(|found| found.token == used.token) {
            s.found.remove(&context);
            if used.source != Source::Stored {
                s.refused.insert((context, used.source));
            }
        }
    });
    used.source != Source::Stored
}

fn clear_remote_session(key: &str) {
    session(|s| {
        s.found.retain(|ctx, _| ctx.remote != key);
        s.missing.retain(|ctx| ctx.remote != key);
        s.refused.retain(|(ctx, _)| ctx.remote != key);
    });
}

fn key_of(remote_url: &str) -> Result<String, String> {
    remote_key(&validate_url(remote_url)?)
}

async fn status_of(key: &str, repo: &str) -> Option<Status> {
    resolve(key, true, Some(repo)).await.map(|found| Status { source: found.source, username: found.username })
}

/// What a request to this remote would use now.
#[tauri::command]
pub async fn credentials_status(remote_url: String, repo_path: String) -> Result<Option<Status>, String> {
    Ok(status_of(&key_of(&remote_url)?, &repo_path).await)
}

/// Keep a pasted token for the remote; it comes first from then on.
#[tauri::command]
pub async fn credentials_set(remote_url: String, repo_path: String, token: String) -> Result<Option<Status>, String> {
    let key = key_of(&remote_url)?;
    let token = token.trim().to_string();
    if token.is_empty() || token.contains(char::is_whitespace) {
        return Err("That doesn't look like a token.".into());
    }
    keychain(move |entry| entry.set_password(&token), &key).await?;
    clear_remote_session(&key);
    Ok(status_of(&key, &repo_path).await)
}

/// Forget the pasted token: back to the user's git credentials.
#[tauri::command]
pub async fn credentials_delete(remote_url: String, repo_path: String) -> Result<Option<Status>, String> {
    let key = key_of(&remote_url)?;
    keychain(|entry| entry.delete_credential(), &key).await?;
    clear_remote_session(&key);
    Ok(status_of(&key, &repo_path).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_git_credential_fill_output() {
        assert_eq!(
            parse_fill("protocol=https\nhost=github.com\nusername=ada\npassword=tok\n"),
            Some(("ada".into(), "tok".into()))
        );
        assert_eq!(parse_fill("password=tok\n"), Some(("x-access-token".into(), "tok".into())));
        assert_eq!(parse_fill("username=ada\npassword=\n"), None);
    }

    #[test]
    fn names_the_token_username_per_host() {
        assert_eq!(token_username("gitlab.com/o/r"), "oauth2");
        assert_eq!(token_username("github.com/o/r"), "x-access-token");
    }

    fn credential(source: Source, token: &str) -> Credential {
        Credential { username: "u".into(), token: token.into(), source }
    }

    #[test]
    fn a_401_moves_past_a_helper_credential() {
        let key = "example.test/o/helper";
        let context = context(key, Some("/repo"));
        let git = credential(Source::Git, "a");
        session(|s| s.found.insert(context.clone(), git.clone()));
        assert!(retry_after(key, Some("/repo"), Some(&git), 401));
        session(|s| {
            assert!(s.found.get(&context).is_none());
            assert!(s.refused.contains(&(context.clone(), Source::Git)));
        });
    }

    #[test]
    fn a_401_on_a_pasted_token_reaches_the_user() {
        let key = "example.test/o/pasted";
        let context = context(key, Some("/repo"));
        let stored = credential(Source::Stored, "b");
        session(|s| s.found.insert(context.clone(), stored.clone()));
        assert!(!retry_after(key, Some("/repo"), Some(&stored), 401));
        session(|s| {
            assert!(s.found.get(&context).is_none());
            assert!(!s.refused.contains(&(context.clone(), Source::Stored)));
        });
    }

    #[test]
    fn only_a_401_says_the_credential_is_bad() {
        let key = "example.test/o/denied";
        let context = context(key, Some("/repo"));
        let git = credential(Source::Git, "a");
        session(|s| s.found.insert(context.clone(), git.clone()));
        for status in [200, 403, 404, 429, 500] {
            assert!(!retry_after(key, Some("/repo"), Some(&git), status));
        }
        assert!(!retry_after(key, Some("/repo"), None, 401));
        session(|s| {
            assert!(s.found.contains_key(&context));
            assert!(!s.refused.contains(&(context.clone(), Source::Git)));
        });
    }

    #[test]
    fn an_old_request_cant_refuse_the_credential_chosen_since() {
        let key = "example.test/o/switched";
        let context = context(key, Some("/repo"));
        let new = credential(Source::Git, "new");
        session(|s| s.found.insert(context.clone(), new.clone()));
        retry_after(key, Some("/repo"), Some(&credential(Source::Stored, "old")), 401);
        session(|s| assert_eq!(s.found.get(&context).map(|f| f.token.as_str()), Some("new")));
    }

    #[test]
    fn helper_results_are_local_to_the_repository_context() {
        let first = context("example.test/o/local", Some("/one"));
        let second = context("example.test/o/local", Some("/two"));
        session(|s| {
            s.found.insert(first, Credential { username: "one".into(), token: "a".into(), source: Source::Git });
            assert!(s.found.get(&second).is_none());
        });
    }
}
