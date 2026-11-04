//! Port of realGit.concurrency.integration.test.ts. Unlike isomorphic-git,
//! gix takes git's own lock files (`index.lock`, ref locks), so the app and
//! system git now exclude each other: a race may fail one side
//! (`LockUnavailable` / a ref-moved error) but never corrupts the repo.

mod common;

use common::*;
use notefig_history::{GixHistoryRepo, HistoryErrorCode, HistoryRepo};

fn setup() -> (tempfile::TempDir, std::path::PathBuf, GixHistoryRepo) {
    let (tmp, ws) = temp_ws();
    let repo = GixHistoryRepo::with_git_dir(&ws, ws.join(".git"));
    repo.ensure_init().unwrap();
    write(&ws.join("seed.md"), "seed\n");
    repo.checkpoint("seed", &author()).unwrap().unwrap();
    (tmp, ws, repo)
}

#[test]
fn concurrent_app_and_system_git_commits_never_corrupt_the_repo() {
    require_git!();
    let (_tmp, ws, repo) = setup();
    for round in 0..6 {
        write(&ws.join(format!("app-{round}.md")), &format!("app {round}\n"));
        write(&ws.join(format!("system-{round}.md")), &format!("system {round}\n"));
        let system = {
            let ws = ws.clone();
            std::thread::spawn(move || {
                let add = run_git_allow_fail(&ws, &["add", &format!("system-{round}.md")]);
                if add.code == 0 {
                    let _ = run_git_allow_fail(&ws, &["commit", "-m", &format!("system commit {round}")]);
                }
            })
        };
        // Either side may lose a race; that's acceptable, corruption is not.
        let _ = repo.checkpoint(&format!("app checkpoint {round}"), &author());
        system.join().unwrap();

        assert_eq!(run_git_allow_fail(&ws, &["fsck", "--full"]).code, 0, "round {round}");
        assert_eq!(run_git(&ws, &["rev-parse", "HEAD"]).len(), 40);
        assert_eq!(run_git_allow_fail(&ws, &["status"]).code, 0);
        assert!(!repo.log(None, None).unwrap().is_empty());
    }
}

#[test]
fn interleaved_app_and_system_git_commits_lose_no_history() {
    require_git!();
    let (_tmp, ws, repo) = setup();
    let mut expected = vec!["seed".to_string()];
    for n in 1..=2 {
        write(&ws.join(format!("app-{n}.md")), &format!("app {n}\n"));
        repo.checkpoint(&format!("app {n}"), &author()).unwrap().unwrap();
        expected.insert(0, format!("app {n}"));

        write(&ws.join(format!("system-{n}.md")), &format!("system {n}\n"));
        run_git(&ws, &["add", &format!("system-{n}.md")]);
        commit_via_git(&ws, &format!("system {n}"));
        expected.insert(0, format!("system {n}"));
    }
    assert_eq!(run_git_allow_fail(&ws, &["fsck", "--full"]).code, 0);
    let subjects: Vec<String> = run_git(&ws, &["log", "--format=%s"]).lines().map(String::from).collect();
    assert_eq!(subjects, expected);
    let log: Vec<String> = repo.log(None, None).unwrap().into_iter().map(|c| c.message.trim().to_string()).collect();
    assert_eq!(log, expected);
    assert_eq!(run_git(&ws, &["status", "--porcelain"]), "");
    let status = repo.status().unwrap();
    assert!(!status.has_changes(), "{status:?}");
}

/// Inverted from the TS suite ("does not use system git's index.lock"):
/// gix honours `index.lock`, so a stale lock now blocks the app with
/// `LockUnavailable` (the panel's Retry path) and leaves the repo intact.
#[test]
fn a_stale_index_lock_blocks_the_app_and_leaves_an_intact_repo() {
    require_git!();
    let (_tmp, ws, repo) = setup();
    let head_before = run_git(&ws, &["rev-parse", "HEAD"]);
    write(&ws.join("change.md"), "change\n");
    let lock = ws.join(".git/index.lock");
    write(&lock, "");

    assert_ne!(run_git_allow_fail(&ws, &["add", "change.md"]).code, 0);
    let err = repo.checkpoint("app commit despite stale lock", &author()).unwrap_err();
    assert_eq!(err.code, HistoryErrorCode::LockUnavailable, "{err:?}");
    assert_eq!(run_git(&ws, &["rev-parse", "HEAD"]), head_before);

    std::fs::remove_file(&lock).unwrap();
    let oid = repo.checkpoint("app commit after the lock cleared", &author()).unwrap().unwrap();
    assert_eq!(run_git_allow_fail(&ws, &["fsck", "--full"]).code, 0);
    assert_eq!(run_git(&ws, &["rev-parse", "HEAD"]), oid);
    assert_eq!(run_git(&ws, &["log", "-1", "--format=%s"]), "app commit after the lock cleared");
}

/// The app's own concurrent checkpoints serialize on the repo's mutex.
#[test]
fn concurrent_checkpoints_in_one_process_serialize() {
    require_git!();
    let (_tmp, ws, repo) = setup();
    let repo = std::sync::Arc::new(repo);
    let handles: Vec<_> = (0..4)
        .map(|i| {
            let repo = repo.clone();
            let ws = ws.clone();
            std::thread::spawn(move || {
                write(&ws.join(format!("t{i}.md")), "x\n");
                repo.checkpoint(&format!("t{i}"), &author())
            })
        })
        .collect();
    for handle in handles {
        handle.join().unwrap().unwrap();
    }
    assert_eq!(run_git_allow_fail(&ws, &["fsck", "--full"]).code, 0);
    assert_eq!(run_git(&ws, &["status", "--porcelain"]), "");
    assert_eq!(run_git(&ws, &["ls-files"]).lines().count(), 5);
}
