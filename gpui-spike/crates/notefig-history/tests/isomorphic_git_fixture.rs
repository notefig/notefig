//! Compatibility with history repos isomorphic-git already wrote (loose
//! objects, its index v2 with faked stat fields). Uses a COPY of a real
//! `<ws>/.notefig/.git`: `NOTEFIG_HISTORY_FIXTURE=<gitdir>`, or the first
//! `~/Documents/*/.notefig/.git` found; skipped when there is none. The
//! source is only read.

mod common;

use std::path::{Path, PathBuf};

use common::*;
use notefig_history::{ChangeKind, GixHistoryRepo, HistoryRepo, Signature};

fn find_fixture() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("NOTEFIG_HISTORY_FIXTURE") {
        return Some(PathBuf::from(path));
    }
    let docs = PathBuf::from(std::env::var("HOME").ok()?).join("Documents");
    let mut candidates: Vec<PathBuf> = std::fs::read_dir(docs)
        .ok()?
        .flatten()
        .map(|e| e.path().join(".notefig/.git"))
        .filter(|p| p.join("HEAD").is_file() && p.join("index").is_file())
        .collect();
    candidates.sort();
    candidates.into_iter().next()
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap().flatten() {
        let ty = entry.file_type().unwrap();
        let target = to.join(entry.file_name());
        if ty.is_dir() {
            copy_dir(&entry.path(), &target);
        } else if ty.is_file() {
            std::fs::copy(entry.path(), &target).unwrap();
        }
    }
}

#[test]
fn opens_reads_and_extends_an_isomorphic_git_history_repo() {
    require_git!();
    let Some(source) = find_fixture() else {
        eprintln!("skipping: no isomorphic-git history repo found");
        return;
    };
    eprintln!("fixture: {}", source.display());
    let (_tmp, ws) = temp_ws();
    let git_dir = ws.join(".notefig/.git");
    copy_dir(&source, &git_dir);
    let gd = git_dir.to_str().unwrap().to_string();
    let wt = ws.to_str().unwrap().to_string();
    let hgit = |args: &[&str]| {
        let mut full = vec!["--git-dir", gd.as_str(), "--work-tree", wt.as_str()];
        full.extend_from_slice(args);
        run_git(&ws, &full)
    };
    let repo = GixHistoryRepo::new(&ws);
    assert!(repo.is_initialized());

    // Log parity with system git.
    let log = repo.log(None, None).unwrap();
    let git_oids: Vec<String> = hgit(&["log", "--format=%H"]).lines().map(String::from).collect();
    assert_eq!(log.iter().map(|c| c.oid.clone()).collect::<Vec<_>>(), git_oids);
    let git_authors: Vec<String> = hgit(&["log", "--format=%an|%at"]).lines().map(String::from).collect();
    assert_eq!(
        log.iter().map(|c| format!("{}|{}", c.author_name, c.author_time)).collect::<Vec<_>>(),
        git_authors
    );

    // Every file at HEAD reads the same as `git show` (first 50).
    let files: Vec<String> = hgit(&["ls-tree", "-r", "--name-only", "HEAD"]).lines().map(String::from).collect();
    for file in files.iter().take(50) {
        let ours = repo.read_text("HEAD", file).unwrap();
        let raw = std::process::Command::new("git")
            .args(["--git-dir", &gd, "show", &format!("HEAD:{file}")])
            .output()
            .unwrap()
            .stdout;
        assert_eq!(ours, String::from_utf8_lossy(&raw), "{file}");
    }

    // Path-scoped log agrees with `git log -- <path>` on a sample file.
    if let Some(file) = files.first() {
        let ours: Vec<String> = repo.log(None, Some(file)).unwrap().into_iter().map(|c| c.oid).collect();
        let theirs: Vec<String> = hgit(&["log", "--format=%H", "--", file]).lines().map(String::from).collect();
        assert_eq!(ours, theirs, "log -- {file}");
    }

    // isomorphic-git's index decodes: with an empty worktree, every indexed
    // file is an unstaged deletion, exactly as system git reports.
    let status = repo.status().unwrap();
    let git_deleted = hgit(&["status", "--porcelain"]).lines().filter(|l| l.trim_start().starts_with("D ")).count();
    let ours_deleted = status.unstaged.iter().filter(|c| c.kind == ChangeKind::Deleted).count();
    assert_eq!(ours_deleted, git_deleted);

    // Restore the worktree from HEAD, then write on top of the isomorphic-git
    // repo and have system git verify it.
    repo.abort_revert().unwrap();
    assert_eq!(hgit(&["status", "--porcelain", "--untracked-files=no"]), "");
    write(&ws.join("added-by-gix.md"), "hello from gix\n");
    let oid = repo.checkpoint("gix checkpoint", &Signature::panel()).unwrap().unwrap();
    assert_eq!(hgit(&["rev-parse", "HEAD"]), oid);
    assert_eq!(hgit(&["show", "HEAD:added-by-gix.md"]), "hello from gix");
    let fsck = run_git_allow_fail(&ws, &["--git-dir", &gd, "fsck", "--full"]);
    assert_eq!(fsck.code, 0, "{}", fsck.stderr);
    let revert = repo.revert_commit(&oid, None, &Signature::panel()).unwrap().unwrap();
    assert_eq!(hgit(&["rev-parse", "HEAD"]), revert);
    assert!(!ws.join("added-by-gix.md").exists());
}
