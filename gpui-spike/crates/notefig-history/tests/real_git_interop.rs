//! Port of realGit.interop.integration.test.ts: every operation cross-checked
//! with the system `git` binary. As in the TS suite, the repo under test is
//! a plain `<dir>/.git` (plus a detached-gitdir block at the end).
//! TS's separate `add`/`commit`/`checkoutPaths`/branch calls are dead in the
//! app and not part of `HistoryRepo`; their cases use `checkpoint` /
//! `abort_revert` instead.

mod common;

use common::*;
use notefig_history::{ChangeKind, GixHistoryRepo, HistoryRepo};

fn plain_repo() -> (tempfile::TempDir, std::path::PathBuf, GixHistoryRepo) {
    let (tmp, ws) = temp_ws();
    let repo = GixHistoryRepo::with_git_dir(&ws, ws.join(".git"));
    (tmp, ws, repo)
}

#[test]
fn init_produces_a_repository_readable_by_system_git() {
    require_git!();
    let (_tmp, ws, repo) = plain_repo();
    repo.ensure_init().unwrap();
    assert_eq!(run_git(&ws, &["rev-parse", "--is-inside-work-tree"]), "true");
    assert_eq!(run_git(&ws, &["branch", "--show-current"]), "main");
}

#[test]
fn checkpoint_is_visible_in_system_git() {
    require_git!();
    let (_tmp, ws, repo) = plain_repo();
    repo.ensure_init().unwrap();
    write(&ws.join("note.md"), "hello\n");
    let oid = repo.checkpoint("Add note", &author()).unwrap().unwrap();
    assert_eq!(run_git(&ws, &["rev-parse", "HEAD"]), oid);
    assert_eq!(run_git(&ws, &["show", "HEAD:note.md"]), "hello");
    assert_eq!(run_git(&ws, &["status", "--porcelain"]), "");
    assert_eq!(run_git(&ws, &["log", "-1", "--format=%an <%ae>|%s"]), "Metrists <dev@metrists.app>|Add note");
    assert_eq!(run_git_allow_fail(&ws, &["fsck", "--full"]).code, 0);
}

#[test]
fn checkpoint_handles_modify_add_delete_and_leaves_clean_status() {
    require_git!();
    let (_tmp, ws, repo) = plain_repo();
    repo.ensure_init().unwrap();
    write(&ws.join("keep.md"), "keep\n");
    write(&ws.join("delete.md"), "delete\n");
    repo.checkpoint("baseline", &author()).unwrap().unwrap();

    write(&ws.join("keep.md"), "keep updated\n");
    std::fs::remove_file(ws.join("delete.md")).unwrap();
    write(&ws.join("new.md"), "new\n");
    let oid = repo.checkpoint("checkpoint", &author()).unwrap().unwrap();

    assert_eq!(oid.len(), 40);
    assert_eq!(run_git(&ws, &["status", "--porcelain"]), "");
    let show = run_git(&ws, &["show", "--name-status", "--format=", "HEAD"]);
    assert!(show.contains("M\tkeep.md"), "{show}");
    assert!(show.contains("D\tdelete.md"), "{show}");
    assert!(show.contains("A\tnew.md"), "{show}");
}

#[test]
fn checkpoint_returns_none_without_changes() {
    require_git!();
    let (_tmp, ws, repo) = plain_repo();
    repo.ensure_init().unwrap();
    assert_eq!(repo.checkpoint("nothing", &author()).unwrap(), None);
    write(&ws.join("a.md"), "a\n");
    repo.checkpoint("one", &author()).unwrap().unwrap();
    assert_eq!(repo.checkpoint("again", &author()).unwrap(), None);
    assert_eq!(repo.log(None, None).unwrap().len(), 1);
}

#[test]
fn checkpoint_rejects_an_empty_message() {
    let (_tmp, _ws, repo) = plain_repo();
    repo.ensure_init().unwrap();
    let err = repo.checkpoint("  ", &author()).unwrap_err();
    assert_eq!(err.code, notefig_history::HistoryErrorCode::InvalidInput);
}

#[test]
fn revert_commit_produces_a_new_commit_visible_to_system_git() {
    require_git!();
    let (_tmp, ws, repo) = plain_repo();
    repo.ensure_init().unwrap();
    write(&ws.join("note.md"), "one\n");
    repo.checkpoint("base", &author()).unwrap();
    write(&ws.join("note.md"), "two\n");
    let change = repo.checkpoint("change", &author()).unwrap().unwrap();

    let revert = repo.revert_commit(&change, None, &author()).unwrap().unwrap();
    assert_eq!(revert.len(), 40);
    assert_eq!(run_git(&ws, &["show", "HEAD:note.md"]), "one");
    assert_eq!(read(&ws.join("note.md")), "one\n");
    assert_eq!(run_git(&ws, &["status", "--porcelain"]), "");
    assert_eq!(run_git(&ws, &["log", "-1", "--format=%s"]), format!("Revert {}", &change[..7]));
    assert_eq!(run_git_allow_fail(&ws, &["fsck", "--full"]).code, 0);
}

#[test]
fn revert_of_an_added_file_deletes_it() {
    require_git!();
    let (_tmp, ws, repo) = plain_repo();
    repo.ensure_init().unwrap();
    write(&ws.join("base.md"), "base\n");
    repo.checkpoint("base", &author()).unwrap();
    write(&ws.join("added.md"), "added\n");
    let add = repo.checkpoint("add", &author()).unwrap().unwrap();
    repo.revert_commit(&add, None, &author()).unwrap().unwrap();
    assert!(!ws.join("added.md").exists());
    assert_eq!(run_git(&ws, &["ls-files"]), "base.md");
    assert_eq!(run_git(&ws, &["status", "--porcelain"]), "");
}

#[test]
fn revert_detects_conflicts_when_head_has_diverged() {
    require_git!();
    let (_tmp, ws, repo) = plain_repo();
    repo.ensure_init().unwrap();
    write(&ws.join("note.md"), "one\n");
    repo.checkpoint("base", &author()).unwrap();
    write(&ws.join("note.md"), "two\n");
    let change = repo.checkpoint("change", &author()).unwrap().unwrap();
    write(&ws.join("note.md"), "three\n");
    repo.checkpoint("diverge", &author()).unwrap();

    let err = repo.revert_commit(&change, None, &author()).unwrap_err();
    assert_eq!(err.code, notefig_history::HistoryErrorCode::MergeRequired);
    assert_eq!(err.message, "Revert would conflict with current changes.");
    // Nothing touched.
    assert_eq!(read(&ws.join("note.md")), "three\n");
    assert_eq!(run_git(&ws, &["log", "-1", "--format=%s"]), "diverge");
}

#[test]
fn revert_is_a_no_op_when_head_is_already_reverted() {
    require_git!();
    let (_tmp, ws, repo) = plain_repo();
    repo.ensure_init().unwrap();
    write(&ws.join("note.md"), "one\n");
    repo.checkpoint("base", &author()).unwrap();
    write(&ws.join("note.md"), "two\n");
    let change = repo.checkpoint("change", &author()).unwrap().unwrap();
    repo.revert_commit(&change, None, &author()).unwrap().unwrap();
    assert_eq!(repo.revert_commit(&change, None, &author()).unwrap(), None);
}

#[test]
fn revert_of_the_root_commit_is_invalid() {
    require_git!();
    let (_tmp, ws, repo) = plain_repo();
    repo.ensure_init().unwrap();
    write(&ws.join("note.md"), "one\n");
    let root = repo.checkpoint("base", &author()).unwrap().unwrap();
    let err = repo.revert_commit(&root, None, &author()).unwrap_err();
    assert_eq!(err.code, notefig_history::HistoryErrorCode::InvalidInput);
}

#[test]
fn revert_to_wip_commits_local_changes_first() {
    require_git!();
    let (_tmp, ws, repo) = plain_repo();
    repo.ensure_init().unwrap();
    write(&ws.join("note.md"), "one\n");
    repo.checkpoint("base", &author()).unwrap();
    write(&ws.join("other.md"), "x\n");
    let change = repo.checkpoint("add other", &author()).unwrap().unwrap();
    write(&ws.join("note.md"), "local edit\n");

    repo.revert_to(&change, &author()).unwrap().unwrap();
    let subjects = run_git(&ws, &["log", "--format=%s"]);
    assert_eq!(
        subjects.lines().collect::<Vec<_>>(),
        vec![format!("Revert {}", &change[..7]), format!("WIP before revert {}", &change[..7]), "add other".into(), "base".into()]
    );
    assert_eq!(read(&ws.join("note.md")), "local edit\n");
    assert!(!ws.join("other.md").exists());
}

#[test]
fn abort_revert_restores_the_working_tree_to_head() {
    require_git!();
    let (_tmp, ws, repo) = plain_repo();
    repo.ensure_init().unwrap();
    write(&ws.join("note.md"), "one\n");
    write(&ws.join("sub/deep.md"), "deep\n");
    repo.checkpoint("base", &author()).unwrap();
    write(&ws.join("note.md"), "dirty\n");
    std::fs::remove_file(ws.join("sub/deep.md")).unwrap();
    write(&ws.join("untracked.md"), "keep me\n");

    repo.abort_revert().unwrap();
    assert_eq!(read(&ws.join("note.md")), "one\n");
    assert_eq!(read(&ws.join("sub/deep.md")), "deep\n");
    assert_eq!(read(&ws.join("untracked.md")), "keep me\n");
    assert_eq!(run_git(&ws, &["status", "--porcelain"]), "?? untracked.md");
}

#[test]
fn read_text_and_log_with_path_filter() {
    require_git!();
    let (_tmp, ws, repo) = plain_repo();
    repo.ensure_init().unwrap();
    write(&ws.join("a.md"), "a1\n");
    let c1 = repo.checkpoint("c1", &author()).unwrap().unwrap();
    write(&ws.join("b.md"), "b1\n");
    let c2 = repo.checkpoint("c2", &author()).unwrap().unwrap();
    write(&ws.join("a.md"), "a2\n");
    let c3 = repo.checkpoint("c3", &author()).unwrap().unwrap();

    assert_eq!(repo.read_text(&c1, "a.md").unwrap(), "a1\n");
    assert_eq!(repo.read_text(&c3, "a.md").unwrap(), "a2\n");
    assert_eq!(repo.read_text(&c3[..7], "a.md").unwrap(), "a2\n");
    assert_eq!(repo.read_text("HEAD", "b.md").unwrap(), "b1\n");
    let missing = repo.read_text(&c1, "b.md").unwrap_err();
    assert_eq!(missing.code, notefig_history::HistoryErrorCode::RepoNotFound);

    let a_log: Vec<String> = repo.log(None, Some("a.md")).unwrap().into_iter().map(|c| c.oid).collect();
    assert_eq!(a_log, vec![c3.clone(), c1.clone()]);
    let git_a_log = run_git(&ws, &["log", "--format=%H", "--", "a.md"]);
    assert_eq!(a_log, git_a_log.lines().map(String::from).collect::<Vec<_>>());
    let all: Vec<String> = repo.log(Some(2), None).unwrap().into_iter().map(|c| c.oid).collect();
    assert_eq!(all, vec![c3, c2]);
}

// --- system git → app-reported state (MET-83 phase 1) ---------------------

#[test]
fn reflects_a_commit_made_by_system_git_in_log_and_status() {
    require_git!();
    let (_tmp, ws, repo) = plain_repo();
    repo.ensure_init().unwrap();
    write(&ws.join("note.md"), "hello\n");
    run_git(&ws, &["add", "note.md"]);
    commit_via_git(&ws, "system commit");
    let head = run_git(&ws, &["rev-parse", "HEAD"]);

    let log = repo.log(None, None).unwrap();
    assert_eq!(log[0].oid, head);
    assert_eq!(log[0].message.trim(), "system commit");
    let status = repo.status().unwrap();
    assert!(status.staged.is_empty() && status.unstaged.is_empty() && status.untracked.is_empty(), "{status:?}");
}

#[test]
fn reflects_a_branch_checked_out_by_system_git() {
    require_git!();
    let (_tmp, ws, repo) = plain_repo();
    repo.ensure_init().unwrap();
    write(&ws.join("note.md"), "hello\n");
    run_git(&ws, &["add", "note.md"]);
    commit_via_git(&ws, "base");
    run_git(&ws, &["checkout", "-b", "feature"]);
    assert_eq!(repo.status().unwrap().current_branch, "feature");
}

#[test]
fn surfaces_an_external_working_tree_edit_as_unstaged() {
    require_git!();
    let (_tmp, ws, repo) = plain_repo();
    repo.ensure_init().unwrap();
    write(&ws.join("note.md"), "one\n");
    run_git(&ws, &["add", "note.md"]);
    commit_via_git(&ws, "base");
    write(&ws.join("note.md"), "two\n");

    let status = repo.status().unwrap();
    assert_eq!(status.unstaged.iter().map(|c| c.path.as_str()).collect::<Vec<_>>(), vec!["note.md"]);
    assert_eq!(status.unstaged[0].kind, ChangeKind::Modified);
    assert!(status.staged.is_empty());
}

#[test]
fn surfaces_a_change_staged_by_system_git_as_staged() {
    require_git!();
    let (_tmp, ws, repo) = plain_repo();
    repo.ensure_init().unwrap();
    write(&ws.join("note.md"), "one\n");
    run_git(&ws, &["add", "note.md"]);
    commit_via_git(&ws, "base");
    write(&ws.join("note.md"), "two\n");
    run_git(&ws, &["add", "note.md"]);

    let status = repo.status().unwrap();
    assert_eq!(status.staged.iter().map(|c| c.path.as_str()).collect::<Vec<_>>(), vec!["note.md"]);
    assert!(status.unstaged.is_empty(), "{status:?}");
}

// --- compatibility scenarios (MET-83 phase 2) -----------------------------

#[test]
fn gitignored_files_are_not_untracked() {
    require_git!();
    let (_tmp, ws, repo) = plain_repo();
    repo.ensure_init().unwrap();
    write(&ws.join(".gitignore"), "ignored.txt\n");
    write(&ws.join("ignored.txt"), "secret\n");
    write(&ws.join("tracked.txt"), "visible\n");

    let status = repo.status().unwrap();
    assert_eq!(status.untracked, vec![".gitignore", "tracked.txt"]);
    let porcelain = run_git(&ws, &["status", "--porcelain"]);
    assert!(porcelain.contains("tracked.txt") && !porcelain.contains("ignored.txt"));
}

#[test]
fn status_parity_with_git_status_porcelain() {
    require_git!();
    let (_tmp, ws, repo) = plain_repo();
    repo.ensure_init().unwrap();
    write(&ws.join("keep.md"), "keep\n");
    run_git(&ws, &["add", "keep.md"]);
    commit_via_git(&ws, "base");
    write(&ws.join("keep.md"), "keep changed\n");
    write(&ws.join("new.md"), "new\n");

    let status = repo.status().unwrap();
    assert_eq!(status.unstaged.iter().map(|c| c.path.as_str()).collect::<Vec<_>>(), vec!["keep.md"]);
    assert_eq!(status.untracked, vec!["new.md"]);
    let porcelain = run_git(&ws, &["status", "--porcelain"]);
    assert!(porcelain.contains("M keep.md") && porcelain.contains("?? new.md"), "{porcelain}");
}

#[test]
fn log_parity_with_system_git() {
    require_git!();
    let (_tmp, ws, repo) = plain_repo();
    repo.ensure_init().unwrap();
    for message in ["first", "second", "third"] {
        write(&ws.join(format!("{message}.md")), &format!("{message}\n"));
        run_git(&ws, &["add", &format!("{message}.md")]);
        commit_via_git(&ws, message);
    }
    let log = repo.log(None, None).unwrap();
    let oids = run_git(&ws, &["log", "--format=%H"]);
    let subjects = run_git(&ws, &["log", "--format=%s"]);
    assert_eq!(log.iter().map(|c| c.oid.as_str()).collect::<Vec<_>>(), oids.lines().collect::<Vec<_>>());
    assert_eq!(log.iter().map(|c| c.message.trim()).collect::<Vec<_>>(), subjects.lines().collect::<Vec<_>>());
    assert_eq!(log[0].author_name, "System Tester");
}

// --- detached gitdir: a second repo over an existing repo's worktree ------

#[test]
fn detached_gitdir_leaves_the_primary_repo_untouched_and_is_readable_by_system_git() {
    require_git!();
    let (_tmp, ws) = temp_ws();
    let git_dir = ws.join(".meta").join(".git");
    run_git(&ws, &["init", "-b", "main"]);
    write(&ws.join("README.md"), "# readme\n");
    run_git(&ws, &["add", "README.md"]);
    commit_via_git(&ws, "init project");
    let primary_exclude = ws.join(".git/info/exclude");
    let stock = std::fs::read_to_string(&primary_exclude).unwrap_or_default();
    write(&primary_exclude, &format!("{stock}.meta/\n"));

    let repo = GixHistoryRepo::with_git_dir(&ws, &git_dir);
    repo.ensure_init().unwrap();
    notefig_history::ensure_exclude_lines(&git_dir, &[".meta/", ".git/"]).unwrap();
    write(&ws.join("notes.md"), "draft\n");
    let oid = repo.checkpoint("checkpoint: draft", &common::author()).unwrap().unwrap();

    assert_eq!(run_git(&ws, &["status", "--porcelain"]), "?? notes.md");
    let gd = git_dir.to_str().unwrap();
    let wt = ws.to_str().unwrap();
    assert_eq!(
        run_git(&ws, &["--git-dir", gd, "--work-tree", wt, "log", "--format=%H %s"]),
        format!("{oid} checkpoint: draft")
    );
    let files = run_git(&ws, &["--git-dir", gd, "ls-tree", "-r", "--name-only", "HEAD"]);
    let files: Vec<&str> = files.lines().collect();
    assert!(files.contains(&"notes.md") && files.contains(&"README.md"), "{files:?}");
    assert!(!files.iter().any(|f| f.starts_with(".git/") || f.starts_with(".meta/")), "{files:?}");
    assert_eq!(run_git_allow_fail(&ws, &["--git-dir", gd, "fsck", "--full"]).code, 0);
}

#[test]
fn detached_gitdir_honors_the_worktree_gitignore() {
    require_git!();
    let (_tmp, ws) = temp_ws();
    let git_dir = ws.join(".meta").join(".git");
    write(&ws.join(".gitignore"), "node_modules/\n*.log\n");
    write(&ws.join("node_modules/dep/index.js"), "module.exports = 1;\n");
    write(&ws.join("debug.log"), "noise\n");
    write(&ws.join("notes.md"), "draft\n");

    let repo = GixHistoryRepo::with_git_dir(&ws, &git_dir);
    repo.ensure_init().unwrap();
    repo.checkpoint("checkpoint", &common::author()).unwrap().unwrap();
    let files = run_git(&ws, &["--git-dir", git_dir.to_str().unwrap(), "ls-tree", "-r", "--name-only", "HEAD"]);
    let files: Vec<&str> = files.lines().collect();
    assert_eq!(files, vec![".gitignore", "notes.md"]);
}
