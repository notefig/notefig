//! Shared harness for the real-git suites (port of realGit.test-helpers.ts):
//! spawn the system `git` binary with a hermetic identity, and temp dirs.
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::process::Command;

use notefig_history::Signature;

pub struct GitRun {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// Hermetic: no global/system config, so `git` never depends on the host.
fn git_command(dir: &Path, args: &[&str]) -> Command {
    let mut cmd = Command::new("git");
    cmd.current_dir(dir)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_AUTHOR_NAME", "System Tester")
        .env("GIT_AUTHOR_EMAIL", "system@test.local")
        .env("GIT_COMMITTER_NAME", "System Tester")
        .env("GIT_COMMITTER_EMAIL", "system@test.local")
        .args(args);
    cmd
}

pub fn run_git_allow_fail(dir: &Path, args: &[&str]) -> GitRun {
    let out = git_command(dir, args).output().expect("spawn git");
    GitRun {
        code: out.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&out.stdout).trim().to_string(),
        stderr: String::from_utf8_lossy(&out.stderr).trim().to_string(),
    }
}

/// Run system `git`, panicking on a non-zero exit; trimmed stdout.
pub fn run_git(dir: &Path, args: &[&str]) -> String {
    let run = run_git_allow_fail(dir, args);
    assert_eq!(run.code, 0, "git {} failed: {}", args.join(" "), run.stderr);
    run.stdout
}

pub fn commit_via_git(dir: &Path, message: &str) -> String {
    run_git(dir, &["commit", "-m", message])
}

pub fn has_system_git() -> bool {
    Command::new("git").arg("--version").output().is_ok_and(|o| o.status.success())
}

/// Skip (return early) when no system git exists, like `describe.skip`.
#[macro_export]
macro_rules! require_git {
    () => {
        if !common::has_system_git() {
            eprintln!("skipping: no system git");
            return;
        }
    };
}

pub fn author() -> Signature {
    Signature::new("Metrists", "dev@metrists.app")
}

pub fn temp_ws() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::Builder::new().prefix("notefig-history-").tempdir().expect("tempdir");
    // Canonical: macOS temp dirs live behind the /var → /private/var symlink.
    let path = dir.path().canonicalize().expect("canonicalize");
    (dir, path)
}

pub fn write(path: &Path, content: &str) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(path, content).unwrap();
}

pub fn read(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap()
}

/// Content of every file under `root`, keyed by relative path (for
/// "byte-identical" checks of the user's .git).
pub fn snapshot_dir(root: &Path) -> std::collections::BTreeMap<String, Vec<u8>> {
    let mut out = std::collections::BTreeMap::new();
    fn walk(root: &Path, dir: &Path, out: &mut std::collections::BTreeMap<String, Vec<u8>>) {
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            let ty = entry.file_type().unwrap();
            if ty.is_dir() {
                walk(root, &path, out);
            } else if ty.is_file() {
                let rel = path.strip_prefix(root).unwrap().to_string_lossy().into_owned();
                out.insert(rel, std::fs::read(&path).unwrap());
            }
        }
    }
    walk(root, root, &mut out);
    out
}
