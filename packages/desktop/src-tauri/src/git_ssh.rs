//! SSH remotes, served behind `git_http_request`: isomorphic-git only speaks
//! HTTP, so the git package names an SSH remote with a bridge URL (see
//! `sshBridgeUrl` in `@notefig/git`) and this turns its requests into runs of
//! the system `ssh`. Notefig never sees a key: agent, `~/.ssh/config` and
//! `known_hosts` work as they do for the user's own `git push`.
//!
//! Each request is one ssh session, as each is one HTTP round trip. The ref
//! listing reads the advertisement and hangs up; the request after it opens
//! a new session, skips the advertisement and sends what the HTTP POST would.
//! The server checks a push's expected old values against its refs then.
//! On macOS and Linux the sessions to one remote share a connection that
//! stays up for a minute after the last one (see `control_dir`), so only the
//! first pays the handshake.
//!
//! `BatchMode` means ssh fails instead of prompting. A failure becomes the
//! status the git package maps to an error the user can act on.

use std::collections::BTreeMap;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncBufRead, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use url::Url;

use crate::credentials::find_tool;
use crate::fs_ops::percent_decode;

pub const BRIDGE_HOST: &str = "ssh.notefig.invalid";
const TIMEOUT: Duration = Duration::from_secs(120);
const FLUSH: &[u8] = b"0000";
/// Limits on what a server can make the app hold. Past them a session ends;
/// stderr is only diagnostics, so the rest of it is read and dropped.
#[cfg(not(test))]
const MAX_ANSWER: usize = 1 << 30;
#[cfg(not(test))]
const MAX_ADVERTISEMENT: usize = 1 << 28;
#[cfg(test)]
const MAX_ANSWER: usize = 1 << 20;
#[cfg(test)]
const MAX_ADVERTISEMENT: usize = 1 << 16;
const MAX_STDERR: usize = 1 << 16;
const TOO_MUCH: &str = "The SSH server sent more data than Notefig can take.";
const UNVERIFIED_HOST: u16 = 495;
const NO_SSH: u16 = 501;

pub type Answer = (u16, BTreeMap<String, String>, Vec<u8>);

#[derive(Debug, PartialEq)]
struct SshRemote {
    destination: String,
    port: Option<u16>,
    path: String,
}

fn check_name(name: &str) -> Result<(), String> {
    // A name starting with `-` would be read as an ssh option.
    if name.is_empty() || name.starts_with('-') || name.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("That isn't a valid SSH remote.".into());
    }
    Ok(())
}

fn build_remote(user: Option<&str>, host: &str, port: Option<u16>, path: &str) -> Result<SshRemote, String> {
    let host = host.trim_start_matches('[').trim_end_matches(']');
    check_name(host)?;
    if let Some(user) = user {
        check_name(user)?;
    }
    if path.is_empty() || path.contains(['\0', '\n']) {
        return Err("That isn't a valid SSH remote.".into());
    }
    let destination = user.map_or_else(|| host.to_string(), |user| format!("{user}@{host}"));
    Ok(SshRemote { destination, port, path: path.to_string() })
}

/// `ssh://[user@]host[:port]/path` or git's `[user@]host:path`.
fn parse_remote(raw: &str) -> Result<SshRemote, String> {
    if raw.starts_with("ssh://") {
        let url = Url::parse(raw).map_err(|_| "That isn't a valid SSH remote.".to_string())?;
        if url.password().is_some() {
            return Err("The remote URL must not carry credentials.".into());
        }
        let path = percent_decode(url.path()).ok_or("That isn't a valid SSH remote.")?;
        // `ssh://host/~/repo` is relative to the home directory, as in git.
        let path = path.strip_prefix('/').filter(|rest| rest.starts_with('~')).unwrap_or(&path);
        let user = percent_decode(url.username()).ok_or("That isn't a valid SSH remote.")?;
        let user = Some(user.as_str()).filter(|name| !name.is_empty());
        return build_remote(user, url.host_str().unwrap_or_default(), url.port(), path);
    }
    // `[…]` brackets an IPv6 host only where the host starts; elsewhere a
    // bracket is part of the path.
    let host_start = raw.find(['@', ':']).filter(|&at| raw.as_bytes()[at] == b'@').map_or(0, |at| at + 1);
    let colon = match raw[host_start..].starts_with('[') {
        true => raw[host_start..].find("]:").map(|end| host_start + end + 1),
        false => raw.find(':'),
    }
    .ok_or("That isn't a valid SSH remote.")?;
    let (authority, path) = (&raw[..colon], &raw[colon + 1..]);
    let (user, host) = authority.split_once('@').map_or((None, authority), |(user, host)| (Some(user), host));
    build_remote(user, host, None, path)
}

/// Quoted for the remote shell the way git quotes it.
fn shell_quote(text: &str) -> String {
    let mut out = String::from("'");
    for c in text.chars() {
        match c {
            '\'' | '!' => {
                out.push_str("'\\");
                out.push(c);
                out.push('\'');
            }
            _ => out.push(c),
        }
    }
    out.push('\'');
    out
}

/// A short, stable name for the destination and port as written.
fn alias_key(remote: &SshRemote) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    (&remote.destination, remote.port).hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn ssh_args(remote: &SshRemote, service: &str, control: Option<&Path>) -> Vec<String> {
    let mut args: Vec<String> = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"].map(String::from).to_vec();
    if let Some(port) = remote.port {
        args.extend(["-p".to_string(), port.to_string()]);
    }
    if let Some(dir) = control {
        // `%C` hashes the host, port and user ssh resolves, which two
        // `~/.ssh/config` aliases with different keys can share. The name as
        // written goes in too, so each alias signs in with its own key.
        let path = format!("ControlPath={}/{}-%C", dir.display(), alias_key(remote));
        args.extend(["-o", "ControlMaster=auto", "-o", &path, "-o", "ControlPersist=60s"].map(String::from));
    }
    args.extend(["--".to_string(), remote.destination.clone(), format!("{service} {}", shell_quote(&remote.path))]);
    args
}

/// Where ssh keeps one shared connection per remote, so a poll every second
/// or two doesn't pay a handshake each time. It's under `/tmp` because a
/// socket path must stay short (104 bytes on macOS), and it's used only when
/// it's ours alone: a directory someone else made or can enter is refused,
/// and each session then connects on its own. Windows' OpenSSH can't share
/// connections.
#[cfg(unix)]
fn control_dir() -> Option<&'static Path> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
    static DIR: std::sync::OnceLock<Option<std::path::PathBuf>> = std::sync::OnceLock::new();
    DIR.get_or_init(|| {
        let uid = unsafe { libc::getuid() };
        let dir = std::path::PathBuf::from(format!("/tmp/notefig-ssh-{uid}"));
        let _ = std::fs::DirBuilder::new().mode(0o700).create(&dir);
        let meta = std::fs::symlink_metadata(&dir).ok()?;
        let private = meta.is_dir() && meta.uid() == uid && meta.permissions().mode() & 0o077 == 0;
        private.then_some(dir)
    })
    .as_deref()
}

#[cfg(not(unix))]
fn control_dir() -> Option<&'static Path> {
    None
}

/// The status for what ssh or the server said on stderr, if it's a known
/// failure.
fn failure_status(stderr: &str) -> Option<u16> {
    let text = stderr.to_ascii_lowercase();
    let says = |phrases: &[&str]| phrases.iter().any(|phrase| text.contains(phrase));
    if says(&["host key verification failed", "remote host identification has changed"]) {
        return Some(UNVERIFIED_HOST);
    }
    if says(&["permission denied (", "too many authentication failures"]) {
        return Some(401);
    }
    if says(&["repository not found", "could not be found", "does not appear to be a git repository", "not a git repository"]) {
        return Some(404);
    }
    if says(&["permission to", "not allowed to", "access denied", "permission denied"]) {
        return Some(403);
    }
    None
}

/// Read pkt-lines through the flush that ends a ref advertisement. `None` if
/// the stream isn't one; an error if it's longer than any real one.
async fn read_advertisement(reader: &mut (impl AsyncBufRead + Unpin)) -> Result<Option<Vec<u8>>, String> {
    let mut out = Vec::new();
    loop {
        let mut prefix = [0u8; 4];
        if reader.read_exact(&mut prefix).await.is_err() {
            return Ok(None);
        }
        out.extend_from_slice(&prefix);
        let length = std::str::from_utf8(&prefix).ok().and_then(|hex| usize::from_str_radix(hex, 16).ok());
        let Some(length) = length else {
            return Ok(None);
        };
        if length == 0 {
            return Ok(Some(out));
        }
        let Some(size) = length.checked_sub(4) else {
            return Ok(None);
        };
        if out.len() + size > MAX_ADVERTISEMENT {
            return Err(TOO_MUCH.into());
        }
        let mut line = vec![0u8; size];
        if reader.read_exact(&mut line).await.is_err() {
            return Ok(None);
        }
        out.extend_from_slice(&line);
    }
}

/// One session: the advertisement alone, or, with `input`, what the server
/// answers to it (the advertisement is dropped, as HTTP never sends it here).
async fn exchange(program: &Path, args: &[String], path: Option<&str>, input: Option<Vec<u8>>) -> Result<Result<Vec<u8>, String>, String> {
    let mut command = Command::new(program);
    command.args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    if let Some(path) = path {
        command.env("PATH", path);
    }
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let (mut stdin, mut stdout, mut stderr) = match (child.stdin.take(), child.stdout.take(), child.stderr.take()) {
        (Some(stdin), Some(stdout), Some(stderr)) => (stdin, BufReader::new(stdout), stderr),
        _ => return Err("Couldn't talk to ssh.".into()),
    };
    let errors = tokio::spawn(async move {
        let mut text = Vec::new();
        let _ = (&mut stderr).take(MAX_STDERR as u64).read_to_end(&mut text).await;
        let _ = tokio::io::copy(&mut stderr, &mut tokio::io::sink()).await;
        String::from_utf8_lossy(&text).into_owned()
    });
    let advertised = read_advertisement(&mut stdout).await?;
    let answer = match (advertised, input) {
        (None, _) => Vec::new(),
        (Some(advertisement), None) => {
            // A flush tells the server there's nothing to do.
            let _ = stdin.write_all(FLUSH).await;
            drop(stdin);
            advertisement
        }
        (Some(_), Some(body)) => {
            // Together: a big pack fills the pipes in both directions.
            let send = async move {
                let _ = stdin.write_all(&body).await;
                drop(stdin);
            };
            let mut answer = Vec::new();
            let mut limited = (&mut stdout).take(MAX_ANSWER as u64 + 1);
            let (_, read) = tokio::join!(send, limited.read_to_end(&mut answer));
            read.map_err(|e| e.to_string())?;
            if answer.len() > MAX_ANSWER {
                return Err(TOO_MUCH.into());
            }
            answer
        }
    };
    child.wait().await.map_err(|e| e.to_string())?;
    let stderr = errors.await.unwrap_or_default();
    Ok(if answer.is_empty() { Err(stderr) } else { Ok(answer) })
}

fn headers_for(content_type: String) -> BTreeMap<String, String> {
    BTreeMap::from([("content-type".to_string(), content_type)])
}

fn service_header(service: &str) -> Vec<u8> {
    let line = format!("# service={service}\n");
    format!("{:04x}{line}0000", line.len() + 4).into_bytes()
}

async fn answer_with(program: &Path, path: Option<&str>, control: Option<&Path>, url: &Url, post: bool, body: Vec<u8>) -> Result<Answer, String> {
    let segments: Vec<&str> = url.path_segments().map(Iterator::collect).unwrap_or_default();
    let service_query = || url.query_pairs().find(|(name, _)| name == "service").map(|(_, value)| value.into_owned());
    let (encoded, service) = match segments.as_slice() {
        [encoded, "info", "refs"] if !post => (*encoded, service_query()),
        [encoded, service] if post => (*encoded, Some((*service).to_string())),
        _ => (segments.first().copied().unwrap_or_default(), None),
    };
    let service = service
        .filter(|name| name == "git-upload-pack" || name == "git-receive-pack")
        .ok_or("Not a git request.")?;
    let remote = parse_remote(&percent_decode(encoded).ok_or("That isn't a valid SSH remote.")?)?;
    let args = ssh_args(&remote, &service, control);
    let input = post.then_some(body);
    let run = exchange(program, &args, path, input);
    let outcome = tokio::time::timeout(TIMEOUT, run).await.map_err(|_| "ssh timed out.".to_string())??;
    match outcome {
        Err(stderr) => match failure_status(&stderr) {
            Some(status) => Ok((status, BTreeMap::new(), stderr.into_bytes())),
            None => Err(stderr.trim().to_string()),
        },
        Ok(answer) if post => Ok((200, headers_for(format!("application/x-{service}-result")), answer)),
        Ok(answer) => {
            let mut framed = service_header(&service);
            framed.extend_from_slice(&answer);
            Ok((200, headers_for(format!("application/x-{service}-advertisement")), framed))
        }
    }
}

/// Serve one bridged git request over ssh.
pub async fn request(url: &Url, post: bool, body: Vec<u8>) -> Result<Answer, String> {
    let path = crate::agent_proc::resolve_login_path().await.ok().flatten().or_else(|| std::env::var("PATH").ok());
    let Some(program) = find_tool("ssh", path.as_deref()) else {
        return Ok((NO_SSH, BTreeMap::new(), Vec::new()));
    };
    answer_with(&program, path.as_deref(), control_dir(), url, post, body).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn remote(destination: &str, port: Option<u16>, path: &str) -> SshRemote {
        SshRemote { destination: destination.into(), port, path: path.into() }
    }

    #[test]
    fn reads_both_remote_forms() {
        assert_eq!(parse_remote("git@github.com:team/notes.git"), Ok(remote("git@github.com", None, "team/notes.git")));
        assert_eq!(parse_remote("gh:team/notes.git"), Ok(remote("gh", None, "team/notes.git")));
        assert_eq!(parse_remote("g:team/notes.git"), Ok(remote("g", None, "team/notes.git")));
        assert_eq!(parse_remote("host:notes[2026].git"), Ok(remote("host", None, "notes[2026].git")));
        assert_eq!(parse_remote("git@host:a[1]:b.git"), Ok(remote("git@host", None, "a[1]:b.git")));
        assert_eq!(parse_remote("git@host:/abs/notes.git"), Ok(remote("git@host", None, "/abs/notes.git")));
        assert_eq!(parse_remote("git@[::1]:notes.git"), Ok(remote("git@::1", None, "notes.git")));
        assert_eq!(parse_remote("ssh://git@host:2222/team/notes.git"), Ok(remote("git@host", Some(2222), "/team/notes.git")));
        assert_eq!(parse_remote("ssh://host/~/notes.git"), Ok(remote("host", None, "~/notes.git")));
        assert_eq!(parse_remote("ssh://git@host/my%20notes.git"), Ok(remote("git@host", None, "/my notes.git")));
        assert_eq!(parse_remote("ssh://alice%40example.com@host/x.git"), Ok(remote("alice@example.com@host", None, "/x.git")));
    }

    #[test]
    fn refuses_names_ssh_would_read_as_options() {
        assert!(parse_remote("-oProxyCommand=evil:x").is_err());
        assert!(parse_remote("ssh://-oProxyCommand=evil/x").is_err());
        assert!(parse_remote("-l@host:x").is_err());
        assert!(parse_remote("host:").is_err());
        assert!(parse_remote("ssh://u:secret@host/x").is_err());
    }

    #[test]
    fn quotes_the_path_for_the_remote_shell() {
        assert_eq!(shell_quote("a b.git"), "'a b.git'");
        assert_eq!(shell_quote("it's!.git"), "'it'\\''s'\\!'.git'");
        let args = ssh_args(&remote("git@host", Some(22), "$(touch x).git"), "git-upload-pack", None);
        assert_eq!(args[args.len() - 3..], ["--", "git@host", "git-upload-pack '$(touch x).git'"]);
        assert_eq!(args[..6], ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-p", "22"]);
    }

    #[test]
    fn shares_one_connection_per_remote_when_it_has_a_private_directory() {
        let shared = ssh_args(&remote("git@host", None, "x.git"), "git-upload-pack", Some(Path::new("/tmp/d")));
        let path = format!("ControlPath=/tmp/d/{}-%C", alias_key(&remote("git@host", None, "x.git")));
        let options = ["-o", "ControlMaster=auto", "-o", &path, "-o", "ControlPersist=60s"];
        assert_eq!(shared[4..10], options);
        assert_eq!(shared[10..], ["--", "git@host", "git-upload-pack 'x.git'"]);
        let alone = ssh_args(&remote("git@host", None, "x.git"), "git-upload-pack", None);
        assert!(!alone.iter().any(|arg| arg.starts_with("Control")));
    }

    #[test]
    fn gives_each_alias_its_own_connection() {
        let key = |destination: &str, port| alias_key(&remote(destination, port, "x.git"));
        assert_ne!(key("git@gh-work", None), key("git@gh-home", None));
        assert_ne!(key("git@host", None), key("git@host", Some(2222)));
        assert_eq!(key("git@host", None), key("git@host", None));
        assert_eq!(key("git@host", None).len(), 16);
    }

    #[cfg(unix)]
    #[test]
    fn keeps_the_shared_connections_where_only_this_user_can_reach_them() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let dir = control_dir().expect("a private directory under /tmp");
        let meta = std::fs::symlink_metadata(dir).unwrap();
        assert_eq!(meta.uid(), unsafe { libc::getuid() });
        assert_eq!(meta.permissions().mode() & 0o077, 0);
        assert!(dir.as_os_str().len() + 1 + 16 + 1 + 40 < 104, "a socket path must stay short");
    }

    #[test]
    fn names_each_failure_the_user_can_act_on() {
        assert_eq!(failure_status("Host key verification failed.\n"), Some(495));
        assert_eq!(failure_status("git@github.com: Permission denied (publickey).\n"), Some(401));
        assert_eq!(failure_status("ERROR: Repository not found.\n"), Some(404));
        assert_eq!(failure_status("fatal: '/x.git' does not appear to be a git repository\n"), Some(404));
        assert_eq!(failure_status("ERROR: Permission to team/notes.git denied to ada.\n"), Some(403));
        assert_eq!(failure_status("ssh: connect to host h port 22: Connection refused\n"), None);
    }

    #[cfg(unix)]
    mod with_real_git {
        use super::*;
        use std::os::unix::fs::PermissionsExt;
        use std::process::Command as Sync;

        fn git(dir: &Path, args: &[&str]) -> String {
            let output = Sync::new("git").current_dir(dir).args(args).output().unwrap();
            assert!(output.status.success(), "{args:?}: {}", String::from_utf8_lossy(&output.stderr));
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        }

        /// A bare repo with `main` and `gone`, and an `ssh` that runs the
        /// remote command here.
        fn fixture(ssh_body: &str) -> (tempfile::TempDir, std::path::PathBuf, String, String) {
            let dir = tempfile::tempdir().unwrap();
            let bare = dir.path().join("my notes.git");
            std::fs::create_dir(&bare).unwrap();
            git(&bare, &["init", "-q", "--bare", "-b", "main"]);
            let work = dir.path().join("work");
            std::fs::create_dir(&work).unwrap();
            git(&work, &["init", "-q", "-b", "main"]);
            std::fs::write(work.join("a.md"), "a\n").unwrap();
            git(&work, &["add", "-A"]);
            git(&work, &["-c", "user.name=T", "-c", "user.email=t@t", "commit", "-qm", "seed"]);
            git(&work, &["push", "-q", bare.to_str().unwrap(), "main", "main:gone"]);
            let oid = git(&work, &["rev-parse", "HEAD"]);
            let program = dir.path().join("fake-ssh");
            std::fs::write(&program, format!("#!/bin/sh\n{ssh_body}\n")).unwrap();
            std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
            let remote = format!("host:{}", bare.to_str().unwrap());
            (dir, program, remote, oid)
        }

        const RUN_LOCALLY: &str = "for a; do last=$a; done\nPATH=\"$(git --exec-path):$PATH\"\neval \"exec $last\"";

        fn url(remote: &str, suffix: &str) -> Url {
            let encoded: String = remote.bytes().map(|b| format!("%{b:02X}")).collect();
            Url::parse(&format!("https://{BRIDGE_HOST}/{encoded}/{suffix}")).unwrap()
        }

        fn pkt(line: &str) -> String {
            format!("{:04x}{line}", line.len() + 4)
        }

        fn inherited() -> Option<String> {
            std::env::var("PATH").ok()
        }

        #[tokio::test]
        async fn lists_refs_like_the_http_advertisement() {
            let (_dir, ssh, remote, oid) = fixture(RUN_LOCALLY);
            for service in ["git-upload-pack", "git-receive-pack"] {
                let target = url(&remote, &format!("info/refs?service={service}"));
                let (status, headers, body) = answer_with(&ssh, inherited().as_deref(), None, &target, false, vec![]).await.unwrap();
                let text = String::from_utf8_lossy(&body);
                assert_eq!(status, 200);
                assert_eq!(headers["content-type"], format!("application/x-{service}-advertisement"));
                assert!(text.starts_with(&format!("{}0000", pkt(&format!("# service={service}\n")))), "{text}");
                assert!(text.contains(&format!("{oid} refs/heads/main")), "{text}");
                assert!(text.ends_with("0000"), "{text}");
            }
        }

        #[tokio::test]
        async fn fetches_a_pack_in_a_new_session() {
            let (_dir, ssh, remote, oid) = fixture(RUN_LOCALLY);
            let body = format!("{}0000{}", pkt(&format!("want {oid}\n")), pkt("done\n")).into_bytes();
            let (status, headers, answer) = answer_with(&ssh, inherited().as_deref(), None, &url(&remote, "git-upload-pack"), true, body).await.unwrap();
            assert_eq!(status, 200);
            assert_eq!(headers["content-type"], "application/x-git-upload-pack-result");
            assert!(answer.windows(4).any(|w| w == b"PACK"));
        }

        #[tokio::test]
        async fn a_push_applies_in_a_new_session_and_checks_the_old_value() {
            let (dir, ssh, remote, oid) = fixture(RUN_LOCALLY);
            let zero = "0".repeat(40);
            let command = |old: &str| format!("{}0000", pkt(&format!("{old} {zero} refs/heads/gone\0report-status\n"))).into_bytes();
            let target = url(&remote, "git-receive-pack");

            let bare = dir.path().join("my notes.git");
            let stale = git(&bare, &["-c", "user.name=T", "-c", "user.email=t@t", "commit-tree", "HEAD^{tree}", "-m", "elsewhere"]);
            let (_, _, answer) = answer_with(&ssh, inherited().as_deref(), None, &target, true, command(&stale)).await.unwrap();
            assert!(String::from_utf8_lossy(&answer).contains("ng refs/heads/gone"));
            assert_eq!(git(&bare, &["rev-parse", "refs/heads/gone"]), oid);

            let (status, _, answer) = answer_with(&ssh, inherited().as_deref(), None, &target, true, command(&oid)).await.unwrap();
            assert_eq!(status, 200);
            assert!(String::from_utf8_lossy(&answer).contains("ok refs/heads/gone"));
            assert_eq!(git(&bare, &["for-each-ref", "refs/heads/gone"]), "");
        }

        #[tokio::test]
        async fn a_failed_session_becomes_its_status() {
            let (_dir, ssh, remote, _) = fixture("echo 'git@h: Permission denied (publickey).' >&2\nexit 255");
            let target = url(&remote, "info/refs?service=git-upload-pack");
            let (status, ..) = answer_with(&ssh, None, None, &target, false, vec![]).await.unwrap();
            assert_eq!(status, 401);
        }

        #[tokio::test]
        async fn an_unknown_failure_is_no_response() {
            let (_dir, ssh, remote, _) = fixture("echo 'ssh: connect to host h port 22: Connection refused' >&2\nexit 255");
            let target = url(&remote, "info/refs?service=git-upload-pack");
            let error = answer_with(&ssh, None, None, &target, false, vec![]).await.unwrap_err();
            assert!(error.contains("Connection refused"));
        }

        async fn flooded(script: &str, suffix: &str, post: bool) -> Result<Answer, String> {
            let (_dir, ssh, remote, _) = fixture(script);
            let target = url(&remote, suffix);
            let run = answer_with(&ssh, None, None, &target, post, vec![]);
            tokio::time::timeout(Duration::from_secs(20), run).await.expect("a flood must end the session")
        }

        #[tokio::test]
        async fn caps_what_it_keeps_of_stderr_but_keeps_reading_it() {
            let script = "head -c 2000000 /dev/zero | tr '\\0' x >&2\nexit 255";
            let error = flooded(script, "info/refs?service=git-upload-pack", false).await.unwrap_err();
            assert_eq!(error.len(), MAX_STDERR);
        }

        #[tokio::test]
        async fn ends_a_session_with_an_endless_advertisement() {
            let script = "while :; do printf 0005x || exit; done";
            let error = flooded(script, "info/refs?service=git-upload-pack", false).await.unwrap_err();
            assert_eq!(error, TOO_MUCH);
        }

        #[tokio::test]
        async fn ends_a_session_with_an_endless_answer() {
            let script = "printf 0000\nexec cat /dev/zero";
            let error = flooded(script, "git-upload-pack", true).await.unwrap_err();
            assert_eq!(error, TOO_MUCH);
        }

        #[tokio::test]
        async fn only_serves_git_services() {
            let (_dir, ssh, remote, _) = fixture(RUN_LOCALLY);
            let target = url(&remote, "info/refs?service=rm");
            assert!(answer_with(&ssh, None, None, &target, false, vec![]).await.is_err());
        }
    }
}

