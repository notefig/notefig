//! Port of agents/tools/__tests__/history-tools.test.ts (over the fake), plus
//! the same tools against the real repo, and the fake's own contract.

mod common;

use std::path::Path;

use notefig_history::tools::{history_checkpoint, history_diff, history_log, history_restore, turn_checkpoint};
use notefig_history::{FakeHistoryRepo, GixHistoryRepo, HistoryErrorCode, HistoryRepo, Signature, checkpoint_message};
use serde_json::json;

#[test]
fn history_log_maps_commits_to_log_entries() {
    let repo = FakeHistoryRepo::initialized("/ws");
    repo.write_file("notes.md", "v1");
    let oid = repo.checkpoint("checkpoint one", &Signature::harness("claude-code")).unwrap().unwrap();
    let value = history_log(&repo, None).unwrap();
    let time = repo.log(None, None).unwrap()[0].author_time;
    assert_eq!(
        value,
        json!([{ "oid": oid, "message": "checkpoint one", "author": "claude-code", "timestamp": time * 1000 }])
    );
    // The typed entries serialize in the TS key order (byte-identical text).
    let text = serde_json::to_string(&notefig_history::tools::history_log_entries(&repo, None).unwrap()).unwrap();
    assert_eq!(text, format!(r#"[{{"oid":"{oid}","message":"checkpoint one","author":"claude-code","timestamp":{}}}]"#, time * 1000));
}

#[test]
fn history_log_initializes_and_scopes_to_a_path() {
    let repo = FakeHistoryRepo::new("/ws");
    assert_eq!(history_log(&repo, None).unwrap(), json!([]));
    repo.write_file("a.md", "1");
    let a1 = repo.checkpoint("a1", &Signature::panel()).unwrap().unwrap();
    repo.write_file("b.md", "1");
    repo.checkpoint("b1", &Signature::panel()).unwrap().unwrap();
    let scoped = history_log(&repo, Some("a.md")).unwrap();
    assert_eq!(scoped.as_array().unwrap().len(), 1);
    assert_eq!(scoped[0]["oid"], json!(a1));
}

#[test]
fn history_diff_reads_both_checkpoints_content() {
    let repo = FakeHistoryRepo::initialized("/ws");
    repo.write_file("notes.md", "v1");
    let a = repo.checkpoint("one", &Signature::panel()).unwrap().unwrap();
    repo.write_file("notes.md", "v2");
    let b = repo.checkpoint("two", &Signature::panel()).unwrap().unwrap();
    let value = history_diff(&repo, "notes.md", &a, &b).unwrap();
    assert_eq!(value, json!({ "from": a, "to": b, "fromContent": "v1", "toContent": "v2" }));
}

#[test]
fn history_diff_reports_a_missing_file_as_error_text() {
    let repo = FakeHistoryRepo::initialized("/ws");
    repo.write_file("notes.md", "v1");
    let a = repo.checkpoint("one", &Signature::panel()).unwrap().unwrap();
    let err = history_diff(&repo, "other.md", &a, &a).unwrap_err();
    assert_eq!(err, format!("Could not find file or directory found at \"{a}:other.md\"."));
}

#[test]
fn history_checkpoint_commits_an_explicit_checkpoint_as_the_agent() {
    let repo = FakeHistoryRepo::initialized("/ws");
    repo.write_file("notes.md", "v1");
    let value = history_checkpoint(&repo, "manual save").unwrap();
    let log = repo.log(None, None).unwrap();
    assert_eq!(value, json!({ "oid": log[0].oid }));
    assert_eq!(log[0].message.trim(), "manual save");
    assert_eq!(log[0].author_name, "agent");
    assert_eq!(log[0].author_email, "agent@notefig.local");
    // Nothing changed → {"oid":null}.
    assert_eq!(history_checkpoint(&repo, "again").unwrap().to_string(), r#"{"oid":null}"#);
}

#[test]
fn history_checkpoint_surfaces_errors_as_text() {
    let repo = FakeHistoryRepo::initialized("/ws");
    repo.write_file("notes.md", "v1");
    assert_eq!(history_checkpoint(&repo, " ").unwrap_err(), "Commit message cannot be empty.");
}

#[test]
fn history_restore_writes_the_checkpoint_content_through_the_write_helper() {
    let repo = FakeHistoryRepo::initialized("/ws");
    repo.write_file("notes.md", "old content");
    let oid = repo.checkpoint("one", &Signature::panel()).unwrap().unwrap();
    repo.write_file("notes.md", "new content");
    let mut written = None;
    let value = history_restore(&repo, "notes.md", Path::new("/ws/notes.md"), &oid, |path, content| {
        written = Some((path.to_path_buf(), content.to_string()));
        Ok(())
    })
    .unwrap();
    assert_eq!(value, serde_json::Value::Null);
    assert_eq!(written, Some((Path::new("/ws/notes.md").to_path_buf(), "old content".to_string())));
}

#[test]
fn history_restore_passes_a_write_failure_through() {
    let repo = FakeHistoryRepo::initialized("/ws");
    repo.write_file("notes.md", "x");
    let oid = repo.checkpoint("one", &Signature::panel()).unwrap().unwrap();
    let err = history_restore(&repo, "notes.md", Path::new("/ws/notes.md"), &oid, |_, _| Err("disk full".into()));
    assert_eq!(err.unwrap_err(), "disk full");
}

#[test]
fn checkpoint_message_truncates_at_72_chars() {
    assert_eq!(checkpoint_message("short"), "short");
    let long = "x".repeat(80);
    let message = checkpoint_message(&long);
    assert_eq!(message.chars().count(), 70);
    assert!(message.ends_with('…'));
    assert_eq!(checkpoint_message(&"y".repeat(72)), "y".repeat(72));
}

#[test]
fn turn_checkpoint_uses_the_harness_identity() {
    let repo = FakeHistoryRepo::new("/ws");
    repo.write_file("a.md", "1");
    turn_checkpoint(&repo, &"p".repeat(100), "claude-code").unwrap().unwrap();
    let log = repo.log(None, None).unwrap();
    assert_eq!(log[0].author_name, "claude-code");
    assert_eq!(log[0].author_email, "agent@notefig.local");
    assert_eq!(log[0].summary().chars().count(), 70);
}

#[test]
fn fake_revert_conflict_and_abort() {
    let repo = FakeHistoryRepo::initialized("/ws");
    repo.write_file("n.md", "one");
    repo.checkpoint("base", &Signature::panel()).unwrap();
    repo.write_file("n.md", "two");
    let change = repo.checkpoint("change", &Signature::panel()).unwrap().unwrap();
    repo.write_file("n.md", "three");
    repo.checkpoint("diverge", &Signature::panel()).unwrap();
    assert_eq!(repo.revert_commit(&change, None, &Signature::panel()).unwrap_err().code, HistoryErrorCode::MergeRequired);
    repo.write_file("n.md", "dirty");
    assert!(repo.status().unwrap().has_changes());
    repo.abort_revert().unwrap();
    assert_eq!(repo.file("n.md").as_deref(), Some("three"));
    assert!(!repo.status().unwrap().has_changes());
}

#[test]
fn fake_reports_uninitialized_and_injected_errors() {
    let repo = FakeHistoryRepo::new("/ws");
    assert_eq!(repo.status().unwrap_err().code, HistoryErrorCode::RepoNotFound);
    repo.ensure_init().unwrap();
    repo.fail_next(notefig_history::HistoryError::new(HistoryErrorCode::LockUnavailable, "locked"));
    assert_eq!(repo.status().unwrap_err().code, HistoryErrorCode::LockUnavailable);
    assert!(repo.status().is_ok());
}

/// The same tool round trip against the real repo: checkpoint → log →
/// diff → restore (isomorphicGit.integration.test.ts "round-trips
/// checkpoint -> log -> diff (readTextFile) -> restore").
#[test]
fn tools_round_trip_on_the_real_repo() {
    let (_tmp, ws) = common::temp_ws();
    let repo = GixHistoryRepo::new(&ws);
    common::write(&ws.join("notes.md"), "v1\n");
    let first = history_checkpoint(&repo, "first").unwrap()["oid"].as_str().unwrap().to_string();
    common::write(&ws.join("notes.md"), "v2\n");
    let second = history_checkpoint(&repo, "second").unwrap()["oid"].as_str().unwrap().to_string();

    let log = history_log(&repo, Some("notes.md")).unwrap();
    assert_eq!(log.as_array().unwrap().iter().map(|e| e["oid"].as_str().unwrap()).collect::<Vec<_>>(), vec![second.as_str(), first.as_str()]);
    assert_eq!(log[0]["author"], json!("agent"));
    assert_eq!(log[0]["message"], json!("second"));

    let diff = history_diff(&repo, "notes.md", &first, &second).unwrap();
    assert_eq!(diff["fromContent"], json!("v1\n"));
    assert_eq!(diff["toContent"], json!("v2\n"));

    let abs = ws.join("notes.md");
    history_restore(&repo, "notes.md", &abs, &first, |path, content| std::fs::write(path, content).map_err(|e| e.to_string()))
        .unwrap();
    assert_eq!(common::read(&abs), "v1\n");
    assert_eq!(repo.status().unwrap().unstaged.len(), 1);
}
