//! Port of dualRepoIsolation.integration.test.ts: the user's own repo
//! (`<ws>/.git`, driven by system git) and the history repo
//! (`<ws>/.notefig/.git`) share a worktree; history operations never read
//! from or write to the user's `.git` (beyond the one exclude line).

mod common;

use std::path::{Path, PathBuf};

use common::*;
use notefig_history::{GixHistoryRepo, HistoryErrorCode, HistoryRepo, Signature, history_git_dir};

fn history_git(ws: &Path, args: &[&str]) -> String {
    let gd = history_git_dir(ws);
    let mut full = vec!["--git-dir", gd.to_str().unwrap(), "--work-tree", ws.to_str().unwrap()];
    full.extend_from_slice(args);
    run_git(ws, &full)
}

fn snapshot_user_git(ws: &Path) -> std::collections::BTreeMap<String, Vec<u8>> {
    snapshot_dir(&ws.join(".git"))
}

fn panel() -> Signature {
    Signature::panel()
}

/// User repo with README.md + note.md committed, `.notefig/` excluded.
fn init_user_repo(ws: &Path) {
    run_git(ws, &["init", "-b", "main"]);
    write(&ws.join("README.md"), "readme v1\n");
    write(&ws.join("note.md"), "v1\n");
    run_git(ws, &["add", "."]);
    commit_via_git(ws, "user: initial");
    let exclude = ws.join(".git/info/exclude");
    let current = std::fs::read_to_string(&exclude).unwrap_or_default();
    write(&exclude, &format!("{current}.notefig/\n"));
}

fn init_history(repo: &GixHistoryRepo) -> String {
    repo.ensure_init().unwrap();
    repo.checkpoint("checkpoint: initial", &panel()).unwrap().expect("initial checkpoint")
}

fn setup() -> (tempfile::TempDir, PathBuf, GixHistoryRepo) {
    let (tmp, ws) = temp_ws();
    let repo = GixHistoryRepo::new(&ws);
    (tmp, ws, repo)
}

#[test]
fn init_creates_the_history_repo_not_a_workspace_git() {
    require_git!();
    let (_tmp, ws, repo) = setup();
    repo.ensure_init().unwrap();
    assert!(ws.join(".notefig/.git/HEAD").is_file());
    assert!(!ws.join(".git").exists());
    let exclude = read(&ws.join(".notefig/.git/info/exclude"));
    assert!(exclude.ends_with(".notefig/*\n!.notefig/scratchpads\n.git/\n"), "{exclude}");
}

#[test]
fn init_leaves_an_existing_user_repo_byte_identical() {
    require_git!();
    let (_tmp, ws, repo) = setup();
    init_user_repo(&ws);
    let before = snapshot_user_git(&ws);
    repo.ensure_init().unwrap();
    repo.ensure_init().unwrap();
    assert_eq!(snapshot_user_git(&ws), before);
}

#[test]
fn init_adds_the_app_dir_to_the_user_repo_exclude_once() {
    require_git!();
    let (_tmp, ws, repo) = setup();
    run_git(&ws, &["init", "-b", "main"]);
    repo.ensure_init().unwrap();
    repo.ensure_init().unwrap();
    let exclude = read(&ws.join(".git/info/exclude"));
    assert_eq!(exclude.matches(".notefig/").count(), 1, "{exclude}");
    assert_eq!(run_git(&ws, &["status", "--porcelain"]), "");
}

#[test]
fn status_is_repo_not_found_before_init_even_with_a_user_repo() {
    require_git!();
    let (_tmp, ws, repo) = setup();
    init_user_repo(&ws);
    assert!(!repo.is_initialized());
    assert_eq!(repo.status().unwrap_err().code, HistoryErrorCode::RepoNotFound);
    assert_eq!(repo.log(None, None).unwrap_err().code, HistoryErrorCode::RepoNotFound);
}

#[test]
fn status_reports_the_history_view_not_the_users_staging() {
    require_git!();
    let (_tmp, ws, repo) = setup();
    init_user_repo(&ws);
    init_history(&repo);
    write(&ws.join("README.md"), "readme v2\n");
    run_git(&ws, &["add", "README.md"]);

    let status = repo.status().unwrap();
    assert!(status.staged.is_empty(), "{status:?}");
    assert_eq!(status.unstaged.iter().map(|c| c.path.as_str()).collect::<Vec<_>>(), vec!["README.md"]);
}

#[test]
fn status_never_modifies_the_users_git() {
    require_git!();
    let (_tmp, ws, repo) = setup();
    init_user_repo(&ws);
    init_history(&repo);
    write(&ws.join("README.md"), "readme v2\n");
    run_git(&ws, &["add", "README.md"]);
    let before = snapshot_user_git(&ws);
    let porcelain = run_git(&ws, &["status", "--porcelain"]);
    // `git status` may refresh the user's index stat cache: snapshot after it.
    let before = if snapshot_user_git(&ws) == before { before } else { snapshot_user_git(&ws) };
    repo.status().unwrap();
    repo.status().unwrap();
    assert_eq!(snapshot_user_git(&ws), before);
    assert_eq!(run_git(&ws, &["status", "--porcelain"]), porcelain);
}

#[test]
fn log_returns_history_checkpoints_not_the_users_commits() {
    require_git!();
    let (_tmp, ws, repo) = setup();
    init_user_repo(&ws);
    let oid = init_history(&repo);
    let log = repo.log(Some(25), None).unwrap();
    assert_eq!(log.len(), 1);
    assert_eq!(log[0].oid, oid);
    assert_eq!(log[0].summary(), "checkpoint: initial");
    assert_eq!(log[0].author_name, "Notefig");
}

#[test]
fn checkpoint_commits_to_history_and_preserves_the_users_staging() {
    require_git!();
    let (_tmp, ws, repo) = setup();
    init_user_repo(&ws);
    init_history(&repo);
    write(&ws.join("a.md"), "a\n");
    write(&ws.join("b.md"), "b\n");
    run_git(&ws, &["add", "a.md"]);
    let before = snapshot_user_git(&ws);

    let oid = repo.checkpoint("Commit", &panel()).unwrap();
    assert!(oid.is_some());
    assert_eq!(snapshot_user_git(&ws), before);
    assert_eq!(history_git(&ws, &["log", "-1", "--pretty=%s"]), "Commit");
    assert_eq!(history_git(&ws, &["show", "HEAD:a.md"]), "a");
    assert_eq!(history_git(&ws, &["show", "HEAD:b.md"]), "b");
    assert_eq!(history_git(&ws, &["status", "--porcelain"]), "");
}

#[test]
fn revert_reverts_a_history_checkpoint_without_touching_the_users_repo() {
    require_git!();
    let (_tmp, ws, repo) = setup();
    init_user_repo(&ws);
    init_history(&repo);
    write(&ws.join("note.md"), "note v2\n");
    let checkpoint2 = repo.checkpoint("checkpoint: v2", &panel()).unwrap().unwrap();
    run_git(&ws, &["add", "note.md"]);
    commit_via_git(&ws, "user: v2");
    let before = snapshot_user_git(&ws);

    let revert = repo.revert_commit(&checkpoint2, Some(&format!("Revert {}", &checkpoint2[..7])), &panel()).unwrap();
    assert!(revert.is_some());
    assert_eq!(read(&ws.join("note.md")), "v1\n");
    assert_eq!(history_git(&ws, &["log", "-1", "--pretty=%s"]), format!("Revert {}", &checkpoint2[..7]));
    assert_eq!(snapshot_user_git(&ws), before);
}

#[test]
fn abort_revert_restores_the_history_head_not_the_users() {
    require_git!();
    let (_tmp, ws, repo) = setup();
    init_user_repo(&ws);
    init_history(&repo);
    write(&ws.join("note.md"), "history-v2\n");
    repo.checkpoint("checkpoint: v2", &panel()).unwrap().unwrap();
    write(&ws.join("note.md"), "dirty\n");
    let before = snapshot_user_git(&ws);

    repo.abort_revert().unwrap();
    assert_eq!(read(&ws.join("note.md")), "history-v2\n");
    assert_eq!(snapshot_user_git(&ws), before);
}

#[test]
fn index_writes_stay_in_the_history_index() {
    require_git!();
    let (_tmp, ws, repo) = setup();
    init_user_repo(&ws);
    init_history(&repo);
    write(&ws.join("extra.md"), "extra\n");
    run_git(&ws, &["add", "extra.md"]);
    std::fs::remove_file(ws.join("README.md")).unwrap();
    let before = snapshot_user_git(&ws);

    repo.checkpoint("kernel commit", &panel()).unwrap().unwrap();
    let tracked = history_git(&ws, &["ls-files"]);
    assert!(tracked.contains("extra.md") && !tracked.contains("README.md"), "{tracked}");
    assert_eq!(history_git(&ws, &["log", "-1", "--pretty=%s"]), "kernel commit");
    assert_eq!(snapshot_user_git(&ws), before);
    assert!(run_git(&ws, &["ls-files"]).contains("extra.md"));
    assert_eq!(run_git(&ws, &["log", "-1", "--pretty=%s"]), "user: initial");
}

#[test]
fn read_text_serves_the_history_repos_objects() {
    require_git!();
    let (_tmp, ws, repo) = setup();
    init_user_repo(&ws);
    init_history(&repo);
    write(&ws.join("note.md"), "history-v2\n");
    let checkpoint2 = repo.checkpoint("checkpoint: v2", &panel()).unwrap().unwrap();
    write(&ws.join("note.md"), "dirty\n");
    let before = snapshot_user_git(&ws);
    assert_eq!(repo.read_text(&checkpoint2, "note.md").unwrap(), "history-v2\n");
    // HEAD is the history repo's HEAD, not the user's (which has v1).
    assert_eq!(repo.read_text("HEAD", "note.md").unwrap(), "history-v2\n");
    assert_eq!(snapshot_user_git(&ws), before);
}

#[test]
fn status_honors_the_history_repos_own_exclude_without_a_user_repo() {
    require_git!();
    let (_tmp, ws, repo) = setup();
    repo.ensure_init().unwrap();
    write(&ws.join("note.md"), "v1\n");
    write(&ws.join(".notefig/tasks.json"), "{}\n");
    assert_eq!(repo.status().unwrap().untracked, vec!["note.md"]);
}

#[test]
fn scratchpads_are_the_one_app_dir_subtree_history_still_sees() {
    require_git!();
    let (_tmp, ws, repo) = setup();
    repo.ensure_init().unwrap();
    write(&ws.join(".notefig/scratchpads/untitled.md"), "draft\n");
    write(&ws.join(".notefig/tasks.json"), "{}\n");
    write(&ws.join(".notefig/.git/app-internal"), "x\n");

    assert_eq!(repo.status().unwrap().untracked, vec![".notefig/scratchpads/untitled.md"]);
    repo.checkpoint("checkpoint: scratchpad", &panel()).unwrap().unwrap();
    assert_eq!(history_git(&ws, &["ls-files"]), ".notefig/scratchpads/untitled.md");
    // System git agrees nothing else is pending.
    assert_eq!(history_git(&ws, &["status", "--porcelain"]), "");
}

#[test]
fn the_user_gitdir_is_never_versioned_even_without_the_exclude() {
    require_git!();
    let (_tmp, ws, repo) = setup();
    init_user_repo(&ws);
    repo.ensure_init().unwrap();
    // Wipe the history exclude: `.git` dirs must still never be walked.
    write(&ws.join(".notefig/.git/info/exclude"), "");
    repo.checkpoint("c", &panel()).unwrap().unwrap();
    let tracked = history_git(&ws, &["ls-files"]);
    assert!(!tracked.lines().any(|l| l.starts_with(".git/") || l.starts_with(".notefig/.git/")), "{tracked}");
}
