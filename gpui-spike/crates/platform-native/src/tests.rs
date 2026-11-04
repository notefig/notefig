//! The native platform against a temp dir (ports of the Tauri fs, walker
//! and watcher tests that apply here).

use std::cell::RefCell;
use std::path::Path;
use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use notefig_core::testing::TestExecutor;
use notefig_platform::{
    Db, EntryType, FileSystem, FsChangeEvent, FsErrorKind, IgnoreRules, MetadataChangeKind, ReadDirectoryOptions,
    content_hash,
};

use crate::fs::Shared;
use crate::rules::Rules;
use crate::{NativeFs, SqliteDb, watch};

fn setup() -> (tempfile::TempDir, String, Rc<TestExecutor>, NativeFs) {
    // SAFETY: tests set it before any trash call; every test agrees on it.
    unsafe { std::env::set_var("NOTEFIG_NO_TRASH", "1") };
    let dir = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(dir.path()).unwrap().to_string_lossy().to_string();
    let exec = TestExecutor::new();
    let fs = NativeFs::new(exec.clone());
    (dir, root, exec, fs)
}

fn p(root: &str, rel: &str) -> String {
    Path::new(root).join(rel).to_string_lossy().to_string()
}

fn ignore_rules() -> IgnoreRules {
    IgnoreRules { directories: vec!["node_modules".into()], extensions: vec!["zip".into()] }
}

#[test]
fn write_read_create_move_delete_round_trip() {
    let (_d, root, exec, fs) = setup();
    let a = p(&root, "notes/a.md");
    let r = exec.block_on(fs.write_files(vec![(a.clone(), "# A\n".into())]));
    assert!(r.failed.is_empty());
    let read = exec.block_on(fs.read_files(vec![a.clone(), p(&root, "missing.md")]));
    assert_eq!(read.succeeded, vec![(a.clone(), "# A\n".to_string())]);
    assert_eq!(read.failed[0].kind, FsErrorKind::NotFound);
    // No temp files left behind.
    assert_eq!(std::fs::read_dir(p(&root, "notes")).unwrap().count(), 1);

    let created = exec.block_on(fs.create_files(vec![p(&root, "deep/new.md"), a.clone()]));
    assert_eq!(created.succeeded, vec![p(&root, "deep/new.md")]);
    assert_eq!(created.failed[0].kind, FsErrorKind::AlreadyExists);

    let b = p(&root, "moved/b.md");
    exec.block_on(fs.move_file(&a, &b)).unwrap();
    assert_eq!(exec.block_on(fs.move_file(&b, &p(&root, "deep/new.md"))).unwrap_err().kind, FsErrorKind::AlreadyExists);
    exec.block_on(fs.move_directory(&p(&root, "moved"), &p(&root, "moved2"))).unwrap();
    let exists = exec.block_on(fs.exists(vec![p(&root, "moved2/b.md"), b.clone(), p(&root, "moved2")]));
    assert_eq!(exists[0].1, Some(EntryType::File));
    assert_eq!(exists[1].1, None);
    assert_eq!(exists[2].1, Some(EntryType::Directory));

    let meta = exec.block_on(fs.metadata(vec![p(&root, "moved2/b.md")]));
    assert_eq!(meta.succeeded[0].size, 4);
    assert!(meta.succeeded[0].modified_ms > 0);

    let del = exec.block_on(fs.delete_files(vec![p(&root, "moved2/b.md"), p(&root, "moved2")]));
    assert_eq!(del.succeeded.len(), 1);
    assert_eq!(del.failed[0].kind, FsErrorKind::IsDirectory);
    let deld = exec.block_on(fs.delete_directories(vec![p(&root, "deep")], true));
    assert_eq!(deld.succeeded.len(), 1);
    assert!(!Path::new(&p(&root, "deep")).exists());
}

#[test]
fn walk_hides_by_position_and_applies_ignore_rules() {
    let (_d, root, exec, fs) = setup();
    for rel in [
        "a.md",
        "dir/b.md",
        "node_modules/x.js",
        ".git/HEAD",
        ".notefig/scratchpads/s.md",
        ".notefig/internal.json",
        "arch.zip",
        "LICENSE",
    ] {
        let path = Path::new(&root).join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, "x").unwrap();
    }
    let opts = ReadDirectoryOptions { ignore: Some(ignore_rules()), ..ReadDirectoryOptions::all_recursive() };
    let listing = exec.block_on(fs.read_directory(&root, opts)).unwrap();
    let mut rels: Vec<String> = listing.iter().map(|e| e.path[root.len() + 1..].to_string()).collect();
    rels.sort();
    assert_eq!(rels, vec![".notefig", ".notefig/scratchpads", ".notefig/scratchpads/s.md", "LICENSE", "a.md", "dir", "dir/b.md"]);

    let shallow = ReadDirectoryOptions { recursive: false, include_files: true, ..Default::default() };
    let top = exec.block_on(fs.read_directory(&root, shallow)).unwrap();
    assert!(top.iter().all(|e| e.kind == EntryType::File && !e.path[root.len() + 1..].contains('/')));
    let missing = exec.block_on(fs.read_directory(&p(&root, "nope"), ReadDirectoryOptions::all_recursive()));
    assert_eq!(missing.unwrap_err().kind, FsErrorKind::NotFound);
}

#[test]
fn judge_suppresses_own_writes_and_pairs_renames() {
    let (_d, root, _exec, _fs) = setup();
    let shared = Arc::new(Shared::default());
    let rules = Rules::new(Some(&ignore_rules()));
    let mut judge = watch::judge_for_test(vec![root.clone()], rules, shared.clone());
    let a = Path::new(&root).join("a.md");

    // Our own write: suppressed.
    shared.register_app_write(&a, &content_hash("one"));
    std::fs::write(&a, "one").unwrap();
    let ev = judge(vec![(a.clone(), "modify")]);
    assert!(ev.is_empty(), "{ev:?}");

    // Someone else's write: a content change.
    std::fs::write(&a, "two").unwrap();
    let ev = judge(vec![(a.clone(), "modify")]);
    match &ev[..] {
        [FsChangeEvent::Content { changes, .. }] => assert_eq!(changes[0].content, "two"),
        other => panic!("{other:?}"),
    }

    // A rename (both ends reported separately) pairs by content; a hidden
    // or ignored path never surfaces.
    let b = Path::new(&root).join("b.md");
    std::fs::rename(&a, &b).unwrap();
    let ev = judge(vec![(a.clone(), "rename"), (b.clone(), "rename"), (Path::new(&root).join(".git/index"), "modify"), (Path::new(&root).join("node_modules/x"), "create")]);
    match &ev[..] {
        [FsChangeEvent::Metadata { changes, .. }] => {
            assert_eq!(changes.len(), 1);
            assert_eq!(changes[0].kind, MetadataChangeKind::Renamed { old_path: a.to_string_lossy().into() });
        }
        other => panic!("{other:?}"),
    }

    // A deletion.
    std::fs::remove_file(&b).unwrap();
    let ev = judge(vec![(b.clone(), "remove")]);
    match &ev[..] {
        [FsChangeEvent::Metadata { changes, .. }] => assert_eq!(changes[0].kind, MetadataChangeKind::Deleted),
        other => panic!("{other:?}"),
    }

    // A folder rename carries its children.
    std::fs::create_dir_all(Path::new(&root).join("d1")).unwrap();
    std::fs::write(Path::new(&root).join("d1/x.md"), "x").unwrap();
    std::fs::rename(Path::new(&root).join("d1"), Path::new(&root).join("d2")).unwrap();
    let ev = judge(vec![(Path::new(&root).join("d1"), "rename"), (Path::new(&root).join("d2"), "rename")]);
    match &ev[..] {
        [FsChangeEvent::Metadata { changes, .. }] => {
            assert_eq!(changes.len(), 2, "{changes:?}");
            assert!(changes.iter().all(|c| matches!(c.kind, MetadataChangeKind::Renamed { .. })));
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn live_watcher_reports_external_changes_only() {
    let (_d, root, exec, fs) = setup();
    let a = p(&root, "a.md");
    exec.block_on(fs.write_files(vec![(a.clone(), "one".into())]));
    let seen: Rc<RefCell<Vec<FsChangeEvent>>> = Rc::default();
    let sink = seen.clone();
    let sub = exec
        .block_on(fs.watch(vec![root.clone()], "w", Some(ignore_rules()), Rc::new(move |e: &FsChangeEvent| sink.borrow_mut().push(e.clone()))))
        .unwrap();
    std::thread::sleep(Duration::from_millis(300));
    exec.run_until_parked();
    seen.borrow_mut().clear(); // FSEvents can replay recent history.

    exec.block_on(fs.write_files(vec![(a.clone(), "own".into())]));
    std::fs::write(p(&root, "b.md"), "external").unwrap();
    let mentions = |events: &[FsChangeEvent], name: &str| {
        events.iter().any(|e| match e {
            FsChangeEvent::Metadata { changes, .. } => changes.iter().any(|c| c.path.ends_with(name)),
            FsChangeEvent::Content { changes, .. } => changes.iter().any(|c| c.path.ends_with(name)),
        })
    };
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline && !mentions(&seen.borrow(), "b.md") {
        std::thread::sleep(Duration::from_millis(20));
        exec.run_until_parked();
    }
    assert!(mentions(&seen.borrow(), "b.md"), "{:?}", seen.borrow());
    assert!(!mentions(&seen.borrow(), "/a.md"), "{:?}", seen.borrow());
    drop(sub);
}

#[test]
fn sqlite_db_round_trips_documents() {
    let dir = tempfile::tempdir().unwrap();
    let exec = TestExecutor::new();
    let path = dir.path().join("notefig.db");
    let db = SqliteDb::open(&path, exec.clone()).unwrap();
    exec.block_on(db.put("kv:a", "x", serde_json::json!({"n": 1}))).unwrap();
    exec.block_on(db.put("kv:a", "x", serde_json::json!({"n": 2}))).unwrap();
    exec.block_on(db.put("kv:a", "a", serde_json::json!(true))).unwrap();
    exec.block_on(db.put("kv:b", "y", serde_json::json!("z"))).unwrap();
    // A new connection: a new launch.
    let db = SqliteDb::open(&path, exec.clone()).unwrap();
    let rows = exec.block_on(db.load("kv:a")).unwrap();
    assert_eq!(rows, vec![("a".into(), serde_json::json!(true)), ("x".into(), serde_json::json!({"n": 2}))]);
    exec.block_on(db.delete("kv:a", "a")).unwrap();
    exec.block_on(db.clear("kv:b")).unwrap();
    assert_eq!(exec.block_on(db.load("kv:a")).unwrap().len(), 1);
    assert!(exec.block_on(db.load("kv:b")).unwrap().is_empty());
}

#[test]
fn sqlite_db_loads_a_numeric_range() {
    let exec = TestExecutor::new();
    let db = SqliteDb::in_memory(exec.clone()).unwrap();
    for (key, hour) in [("a", 1), ("b", 2), ("c", 3)] {
        exec.block_on(db.put("usage-buckets", key, serde_json::json!({ "hour": hour, "turns": 1 }))).unwrap();
    }
    exec.block_on(db.put("usage-buckets", "x", serde_json::json!({ "other": 2 }))).unwrap();
    exec.block_on(db.put("other", "y", serde_json::json!({ "hour": 2 }))).unwrap();
    let rows = exec.block_on(db.load_range("usage-buckets", "hour", 2.0, 4.0)).unwrap();
    assert_eq!(rows.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(), vec!["b", "c"]);
}
